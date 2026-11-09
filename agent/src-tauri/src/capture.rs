//! Screenshot post-processing: stitch monitors, downscale, optional blur, JPEG.

use image::{RgbaImage, imageops};

/// Maximum width of the stored (stitched) screenshot.
pub const MAX_WIDTH: u32 = 1920;
const JPEG_QUALITY: u8 = 70;

/// Place monitors side by side (top-aligned) on a black canvas.
pub fn stitch(images: &[RgbaImage]) -> RgbaImage {
    if images.len() == 1 {
        return images[0].clone();
    }
    let width: u32 = images.iter().map(|i| i.width()).sum();
    let height = images.iter().map(|i| i.height()).max().unwrap_or(0);
    let mut canvas = RgbaImage::from_pixel(width.max(1), height.max(1), image::Rgba([0, 0, 0, 255]));
    let mut x = 0i64;
    for img in images {
        imageops::replace(&mut canvas, img, x, 0);
        x += img.width() as i64;
    }
    canvas
}

pub fn process(images: &[RgbaImage], blur: bool) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(!images.is_empty(), "no images captured");
    let mut img = stitch(images);
    if img.width() > MAX_WIDTH {
        let h = (img.height() as u64 * MAX_WIDTH as u64 / img.width() as u64).max(1) as u32;
        img = imageops::resize(&img, MAX_WIDTH, h, imageops::FilterType::Triangle);
    }
    if blur {
        // Blur a small copy and scale it back up: much faster than blurring
        // full-size and enough to make text unreadable.
        let (w, h) = img.dimensions();
        let small = imageops::resize(&img, (w / 8).max(1), (h / 8).max(1), imageops::FilterType::Triangle);
        let small = imageops::blur(&small, 2.0);
        img = imageops::resize(&small, w, h, imageops::FilterType::Triangle);
    }
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    rgb.write_with_encoder(enc)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stitches_side_by_side() {
        let a = RgbaImage::from_pixel(100, 50, image::Rgba([255, 0, 0, 255]));
        let b = RgbaImage::from_pixel(60, 80, image::Rgba([0, 255, 0, 255]));
        let s = stitch(&[a, b]);
        assert_eq!(s.dimensions(), (160, 80));
        assert_eq!(s.get_pixel(10, 10)[0], 255);
        assert_eq!(s.get_pixel(110, 10)[1], 255);
        assert_eq!(s.get_pixel(10, 70)[0], 0); // padding under the shorter monitor
    }

    #[test]
    fn downscales_and_encodes_jpeg() {
        let a = RgbaImage::from_pixel(3840, 2160, image::Rgba([10, 20, 30, 255]));
        for blur in [false, true] {
            let jpeg = process(std::slice::from_ref(&a), blur).unwrap();
            assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
            let back = image::load_from_memory(&jpeg).unwrap();
            assert_eq!((back.width(), back.height()), (1920, 1080));
        }
    }
}
