# Security Policy

**openv360** is self-hosted employee-monitoring and time-tracking software. Because it handles sensitive workforce data — activity logs and screenshots — we take security reports seriously and appreciate responsible disclosure.

## Supported versions

openv360 is in active beta (0.x). Security fixes are made against the latest release and the `main` branch only. Please upgrade to the latest version before reporting, and run supported, patched versions in production.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x (latest) | ✅ |
| < 0.1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/Mrhudson69/openv360/security/advisories) of the repository.
2. Click **Report a vulnerability** to open a private security advisory (GitHub Security Advisories).
3. Include as much detail as you can:
   - A description of the vulnerability and its impact.
   - The affected component (`agent/`, `server/`, `dashboard/`, `deploy/`, installer, etc.) and version/commit.
   - Step-by-step reproduction instructions and any proof-of-concept.
   - Your assessment of severity and any suggested remediation.

If you are unable to use private advisories, open a minimal public issue that says only that you have a security report and asks a maintainer to open a private channel — **without** any vulnerability details.

### What to expect

- **Acknowledgement:** we aim to respond within **5 business days**.
- **Updates:** we'll keep you informed as we investigate and work on a fix.
- **Disclosure:** we follow coordinated disclosure — we'll agree on a timeline with you and credit you in the advisory (unless you prefer to remain anonymous) once a fix is released.

Please give us a reasonable amount of time to remediate before any public disclosure.

## Scope

In scope:

- The openv360 server API (`server/`)
- The admin dashboard (`dashboard/`)
- The desktop agent (`agent/`)
- Deployment and installer scripts (`deploy/`, `installer/`, `linux/`)
- Authentication, token/password handling, enrollment, data retention, and screenshot storage

Out of scope (please don't report these as vulnerabilities):

- Issues in third-party dependencies that are already publicly known and tracked upstream (report upstream instead).
- Findings that require physical access to an already-compromised machine, or a misconfiguration of a self-hosted instance that deviates from the documented setup.
- Missing security hardening that has no demonstrated impact (please file as a feature request).

## A note on lawful, transparent use

openv360 is **employer-monitoring software** and must be deployed **lawfully and transparently**. Monitoring laws vary by jurisdiction and many require disclosure to, and/or consent from, the people being monitored. The agent is transparent by design (always visible in the system tray, records only while clocked in, and does not hide its process), and operators are responsible for:

- Disclosing monitoring to employees and obtaining any required consent.
- Deploying only on employer-managed devices with employees' knowledge.
- Configuring screenshots, blur, and data retention appropriately for their legal and privacy obligations.

Reports of features that would enable **covert or unlawful surveillance** are treated as product/design concerns, not security vulnerabilities — but we welcome them via [Discussions](https://github.com/Mrhudson69/openv360/discussions) or an issue, because keeping openv360 transparent is a project goal.

Thank you for helping keep openv360 and its users safe.
