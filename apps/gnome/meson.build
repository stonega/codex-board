project(
  'codex-boards-gnome',
  'c',
  version: '0.1.0',
  meson_version: '>=1.0.0',
)

gnome = import('gnome')
fs = import('fs')

app_id = 'com.codexboards.Gnome'
bindir = get_option('bindir')
datadir = get_option('datadir')
pkgdatadir = datadir / 'codex-boards-gnome'

configure_file(
  input: 'data/codex-boards-gnome.in',
  output: 'codex-boards-gnome',
  configuration: {
    'GJS': find_program('gjs').full_path(),
    'PKGDATADIR': get_option('prefix') / pkgdatadir,
  },
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

install_data(
  'src/main.js',
  install_dir: pkgdatadir,
)

desktop_file = configure_file(
  input: 'data/com.codexboards.Gnome.desktop.in',
  output: '@0@.desktop'.format(app_id),
  copy: true,
  install: true,
  install_dir: datadir / 'applications',
)

metainfo_file = configure_file(
  input: 'data/com.codexboards.Gnome.metainfo.xml.in',
  output: '@0@.metainfo.xml'.format(app_id),
  copy: true,
  install: true,
  install_dir: datadir / 'metainfo',
)

install_data(
  'data/icons/hicolor/scalable/apps/com.codexboards.Gnome.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'scalable' / 'apps',
)

backend_binary = 'resources/backend/codex-boards-backend'
if fs.exists(backend_binary)
  install_data(
    backend_binary,
    install_dir: pkgdatadir / 'backend',
    install_mode: 'rwxr-xr-x',
  )
endif

gnome.post_install(
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)
