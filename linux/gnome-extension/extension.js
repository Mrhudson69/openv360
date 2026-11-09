// openv360 Agent Helper — GNOME Shell extension (GNOME 45+).
//
// On Wayland, ordinary apps can neither see which window is focused nor take
// screenshots without a confirmation dialog. This extension runs inside
// GNOME Shell and exposes both to the openv360 agent over D-Bus at
//   bus name: org.gnome.Shell   path: /org/openv360/Agent
//
// Every call is checked: the caller's executable must be named
// `openv360-agent`, and screenshots may only be written inside the agent's
// own data directory.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const IFACE = `
<node>
  <interface name="org.openv360.Agent">
    <method name="GetFocusedWindow">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="Screenshot">
      <arg type="s" direction="in" name="path"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <property name="Version" type="u" access="read"/>
  </interface>
</node>`;

const ALLOWED_EXE = 'openv360-agent';
const ERR = 'org.openv360.Agent.Error';

export default class openv360Extension extends Extension {
    enable() {
        this._allowed = new Map();
        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'org.openv360.agent']);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/openv360/Agent');
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._allowed = null;
    }

    get Version() {
        return 1;
    }

    async _callerAllowed(invocation) {
        const sender = invocation.get_sender();
        if (this._allowed.has(sender))
            return this._allowed.get(sender);
        let ok = false;
        try {
            const reply = await Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]),
                new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null);
            const [pid] = reply.deep_unpack();
            const exe = GLib.file_read_link(`/proc/${pid}/exe`);
            ok = GLib.path_get_basename(exe) === ALLOWED_EXE;
        } catch (e) {
            logError(e, 'openv360: could not identify D-Bus caller');
        }
        this._allowed.set(sender, ok);
        return ok;
    }

    async GetFocusedWindowAsync(_params, invocation) {
        if (!await this._callerAllowed(invocation)) {
            invocation.return_dbus_error(`${ERR}.Denied`, 'Caller is not the openv360 agent');
            return;
        }
        const w = global.display.focus_window;
        let info = {};
        if (w) {
            const app = Shell.WindowTracker.get_default().get_window_app(w);
            info = {
                app: app?.get_name() || w.get_wm_class() || '',
                appId: app?.get_id() || '',
                wmClass: w.get_wm_class() || '',
                title: w.get_title() || '',
            };
        }
        invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(info)]));
    }

    async ScreenshotAsync([path], invocation) {
        if (!await this._callerAllowed(invocation)) {
            invocation.return_dbus_error(`${ERR}.Denied`, 'Caller is not the openv360 agent');
            return;
        }
        const file = Gio.File.new_for_path(path);
        const dir = Gio.File.new_for_path(this._dataDir);
        if (!file.has_prefix(dir) || !path.endsWith('.png')) {
            invocation.return_dbus_error(`${ERR}.BadPath`, 'Path must be a .png inside the openv360 data directory');
            return;
        }
        try {
            const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
            const shooter = new Shell.Screenshot();
            await shooter.screenshot(false, stream);
            stream.close(null);
            invocation.return_value(new GLib.Variant('(b)', [true]));
        } catch (e) {
            invocation.return_dbus_error(`${ERR}.Failed`, e.message);
        }
    }
}
