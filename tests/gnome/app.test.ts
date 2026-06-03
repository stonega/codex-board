import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '..', '..');
const appRoot = join(root, 'apps', 'gnome');

describe('native GNOME app', () => {
  test('targets the current GNOME SDK/runtime in the Flatpak manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(appRoot, 'com.codexboards.Gnome.json'), 'utf8'),
    );

    expect(manifest.id).toBe('com.codexboards.Gnome');
    expect(manifest.runtime).toBe('org.gnome.Platform');
    expect(manifest.sdk).toBe('org.gnome.Sdk');
    expect(manifest['runtime-version']).toBe('50');
    expect(manifest.command).toBe('codex-boards-gnome');
    expect(manifest['finish-args']).toContain('--socket=wayland');
    expect(manifest['finish-args']).toContain('--filesystem=home:ro');
  });

  test('uses native GNOME components instead of an embedded web view', () => {
    const source = readFileSync(join(appRoot, 'src', 'main.js'), 'utf8');

    expect(source).toContain("import Adw from 'gi://Adw?version=1'");
    expect(source).toContain("import Gtk from 'gi://Gtk?version=4.0'");
    expect(source).toContain(
      'class BoardsWindow extends Adw.ApplicationWindow',
    );
    expect(source).toContain('new Adw.PreferencesWindow');
    expect(source).not.toContain('WebView');
    expect(source).not.toContain('webkit');
  });

  test('covers the desktop board feature endpoints', () => {
    const source = readFileSync(join(appRoot, 'src', 'main.js'), 'utf8');
    const endpoints = [
      '/projects',
      '/views',
      '/settings',
      '/issues?',
      '/review',
      '/sync',
      '/export/multica',
    ];

    for (const endpoint of endpoints) {
      expect(source).toContain(endpoint);
    }
  });

  test('installs the app, desktop metadata, icon, and backend sidecar when available', () => {
    const meson = readFileSync(join(appRoot, 'meson.build'), 'utf8');

    expect(meson).toContain("install_data(\n  'src/main.js'");
    expect(meson).toContain('com.codexboards.Gnome.desktop');
    expect(meson).toContain('com.codexboards.Gnome.metainfo.xml');
    expect(meson).toContain('com.codexboards.Gnome.svg');
    expect(meson).toContain('resources/backend/codex-boards-backend');
    expect(meson).toContain("install_mode: 'rwxr-xr-x'");
  });
});
