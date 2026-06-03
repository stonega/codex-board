#!/usr/bin/env gjs -m

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

const APP_ID = 'com.codexboards.Gnome';
const APP_NAME = 'Codex Boards';
const BACKEND_BINARY_NAME = 'codex-boards-backend';
const DEFAULT_PORT = 7788;
const MAX_PORT = 7888;

const STATUS_OPTIONS = [
  'all',
  'todo',
  'in_progress',
  'blocked',
  'done',
  'unknown',
];
const PRIORITY_OPTIONS = ['all', 'urgent', 'high', 'medium', 'low', 'unknown'];
const PARSE_MODE_OPTIONS = ['all', 'ai', 'fallback'];

const PARSER_PRESETS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3-flash-preview',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
  },
};

function formatLabel(value) {
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  if (!value) {
    return 'Unknown';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function delay(ms) {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

function clearChildren(widget) {
  let child = widget.get_first_child();
  while (child) {
    widget.remove(child);
    child = widget.get_first_child();
  }
}

function addCssClasses(widget, classes) {
  for (const className of classes) {
    widget.add_css_class(className);
  }

  return widget;
}

function makeLabel(label, classes = []) {
  return addCssClasses(
    new Gtk.Label({
      label: String(label ?? ''),
      xalign: 0,
      wrap: true,
      selectable: true,
    }),
    classes,
  );
}

function makePill(label, className = 'pill') {
  return addCssClasses(
    new Gtk.Label({
      label: String(label ?? ''),
      xalign: 0.5,
      valign: Gtk.Align.CENTER,
    }),
    [className],
  );
}

function makeIconLabelButton(iconName, label) {
  const button = new Gtk.Button({ tooltip_text: label });
  const content = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    halign: Gtk.Align.CENTER,
  });
  content.append(new Gtk.Image({ icon_name: iconName }));
  content.append(new Gtk.Label({ label }));
  button.set_child(content);
  return button;
}

function makeDropdown(options, activeValue, onChange) {
  const dropdown = Gtk.DropDown.new_from_strings(options.map(formatLabel));
  const activeIndex = Math.max(0, options.indexOf(activeValue ?? 'all'));
  dropdown.set_selected(activeIndex);
  dropdown.connect('notify::selected', () => {
    onChange(options[dropdown.get_selected()] ?? 'all');
  });
  return dropdown;
}

function encodeQuery(params) {
  return params
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
}

function buildIssuePath(projectId, filters) {
  const params = [['projectId', projectId]];

  if (filters.status && filters.status !== 'all') {
    params.push(['status', filters.status]);
  }
  if (filters.priority && filters.priority !== 'all') {
    params.push(['priority', filters.priority]);
  }
  if (filters.parseMode && filters.parseMode !== 'all') {
    params.push(['parseMode', filters.parseMode]);
  }
  if (filters.needsReview) {
    params.push(['needsReview', 'true']);
  }
  if (filters.hasCommits) {
    params.push(['hasCommits', 'true']);
  }
  if (filters.hasTags) {
    params.push(['hasTags', 'true']);
  }
  if (filters.query) {
    params.push(['query', filters.query]);
  }

  return `/issues?${encodeQuery(params)}`;
}

function readJsonMessage(session, message) {
  return new Promise((resolve, reject) => {
    session.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (_session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          const status = message.get_status();
          const body = new TextDecoder().decode(bytes.toArray());

          if (status < 200 || status >= 300) {
            throw new Error(body || `Request failed with ${status}`);
          }

          resolve(body.length > 0 ? JSON.parse(body) : null);
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

async function requestJson(
  session,
  apiBaseUrl,
  method,
  path,
  body = undefined,
) {
  const message = Soup.Message.new(method, `${apiBaseUrl}${path}`);

  if (body !== undefined) {
    const payload = JSON.stringify(body);
    message.set_request_body_from_bytes(
      'application/json',
      new GLib.Bytes(new TextEncoder().encode(payload)),
    );
  }

  return await readJsonMessage(session, message);
}

function isTcpOpen(port) {
  const client = new Gio.SocketClient({ timeout: 1 });

  try {
    const connection = client.connect_to_host('127.0.0.1', port, null);
    connection.close(null);
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort() {
  for (let port = DEFAULT_PORT; port <= MAX_PORT; port += 1) {
    if (!isTcpOpen(port)) {
      return port;
    }
  }

  throw new Error(
    `No available backend port found between ${DEFAULT_PORT} and ${MAX_PORT}`,
  );
}

function modulePath() {
  const [path] = GLib.filename_from_uri(import.meta.url);
  return path;
}

function resolveAppPaths() {
  const mainPath = modulePath();
  const scriptDir = GLib.path_get_dirname(mainPath);
  const appRoot =
    GLib.path_get_basename(scriptDir) === 'src'
      ? GLib.path_get_dirname(scriptDir)
      : scriptDir;
  const repoRoot =
    GLib.path_get_basename(appRoot) === 'gnome'
      ? GLib.path_get_dirname(GLib.path_get_dirname(appRoot))
      : null;

  return {
    scriptDir,
    appRoot,
    repoRoot,
    sourceBackend: GLib.build_filenamev([
      appRoot,
      'resources',
      'backend',
      BACKEND_BINARY_NAME,
    ]),
    installedBackend: GLib.build_filenamev([
      scriptDir,
      'backend',
      BACKEND_BINARY_NAME,
    ]),
  };
}

function backendSpec() {
  const envBackend = GLib.getenv('CODEX_BOARDS_BACKEND');
  if (envBackend) {
    return { argv: [envBackend, 'serve'], cwd: GLib.get_current_dir() };
  }

  const paths = resolveAppPaths();

  if (GLib.file_test(paths.installedBackend, GLib.FileTest.IS_EXECUTABLE)) {
    return {
      argv: [paths.installedBackend, 'serve'],
      cwd: GLib.get_home_dir(),
    };
  }

  if (GLib.file_test(paths.sourceBackend, GLib.FileTest.IS_EXECUTABLE)) {
    return { argv: [paths.sourceBackend, 'serve'], cwd: paths.appRoot };
  }

  if (paths.repoRoot) {
    const backendEntry = GLib.build_filenamev([
      paths.repoRoot,
      'apps',
      'backend',
      'src',
      'index.ts',
    ]);
    const bun = GLib.find_program_in_path('bun');

    if (bun && GLib.file_test(backendEntry, GLib.FileTest.EXISTS)) {
      return {
        argv: [bun, 'apps/backend/src/index.ts', 'serve'],
        cwd: paths.repoRoot,
      };
    }
  }

  return null;
}

function installApplicationCss() {
  const display = Gdk.Display.get_default();
  if (!display) {
    return;
  }

  const provider = new Gtk.CssProvider();
  const css = `
    .sidebar {
      background: @window_bg_color;
      border-right: 1px solid @borders;
    }
    .muted {
      color: @dim_label_color;
    }
    .heading {
      font-weight: 700;
      font-size: 28px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: @dim_label_color;
    }
    .pill {
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, @accent_bg_color 12%, @window_bg_color);
      color: @accent_color;
      font-size: 12px;
    }
    .neutral-pill {
      padding: 2px 8px;
      border-radius: 999px;
      background: @view_bg_color;
      color: @dim_label_color;
      font-size: 12px;
      border: 1px solid @borders;
    }
    .issue-row {
      padding: 10px 12px;
      border-bottom: 1px solid @borders;
    }
    .table-header {
      padding: 8px 12px;
      background: @view_bg_color;
      border-bottom: 1px solid @borders;
    }
    .preview {
      font-family: monospace;
      padding: 12px;
      border-radius: 8px;
      background: @view_bg_color;
      border: 1px solid @borders;
    }
  `;

  try {
    provider.load_from_data(css);
  } catch {
    provider.load_from_data(css, -1);
  }

  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  );
}

const BoardsWindow = GObject.registerClass(
  class BoardsWindow extends Adw.ApplicationWindow {
    _init(application) {
      super._init({
        application,
        title: APP_NAME,
        default_width: 1440,
        default_height: 960,
      });

      installApplicationCss();

      this.session = new Soup.Session();
      this.apiBaseUrl = null;
      this.backendProcess = null;
      this.projectsResponse = null;
      this.savedViewsResponse = null;
      this.settingsResponse = null;
      this.issuesResponse = null;
      this.selectedProjectId = null;
      this.filters = {
        status: 'all',
        priority: 'all',
        parseMode: 'all',
        query: '',
        needsReview: false,
        hasCommits: false,
        hasTags: false,
      };

      this.buildUi();
      this.start();
    }

    buildUi() {
      this.toastOverlay = new Adw.ToastOverlay();
      const root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      this.toastOverlay.set_child(root);
      this.set_content(this.toastOverlay);

      const sidebar = addCssClasses(
        new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 12,
          width_request: 300,
          margin_top: 12,
          margin_bottom: 12,
          margin_start: 12,
          margin_end: 12,
        }),
        ['sidebar'],
      );

      const brand = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        valign: Gtk.Align.CENTER,
      });
      brand.append(
        new Gtk.Image({ icon_name: 'view-list-symbolic', pixel_size: 24 }),
      );
      brand.append(makeLabel(APP_NAME, ['heading']));
      sidebar.append(brand);

      sidebar.append(makeLabel('Workspace', ['section-title']));
      this.projectList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        vexpand: true,
      });
      this.projectList.add_css_class('boxed-list');
      sidebar.append(
        new Gtk.ScrolledWindow({
          child: this.projectList,
          vexpand: true,
          hscrollbar_policy: Gtk.PolicyType.NEVER,
        }),
      );

      sidebar.append(makeLabel('Saved Views', ['section-title']));
      this.savedViewList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        height_request: 140,
      });
      this.savedViewList.add_css_class('boxed-list');
      sidebar.append(
        new Gtk.ScrolledWindow({
          child: this.savedViewList,
          hscrollbar_policy: Gtk.PolicyType.NEVER,
        }),
      );

      this.syncButton = makeIconLabelButton(
        'view-refresh-symbolic',
        'Run Sync',
      );
      this.syncButton.connect('clicked', () => {
        this.runSync();
      });
      sidebar.append(this.syncButton);

      const settingsButton = makeIconLabelButton(
        'emblem-system-symbolic',
        'Settings',
      );
      settingsButton.connect('clicked', () => {
        this.openSettingsWindow();
      });
      sidebar.append(settingsButton);

      root.append(sidebar);

      const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
      });
      root.append(content);

      const header = new Adw.HeaderBar();
      this.breadcrumbLabel = makeLabel('Projects / Select project', ['muted']);
      header.set_title_widget(this.breadcrumbLabel);
      content.append(header);

      const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
      });
      content.append(scrolled);

      const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 32,
        margin_end: 32,
      });
      scrolled.set_child(page);

      const titleRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        valign: Gtk.Align.CENTER,
      });
      this.projectBadge = makePill('P', 'neutral-pill');
      titleRow.append(this.projectBadge);
      this.projectTitle = makeLabel('Select a project', ['heading']);
      titleRow.append(this.projectTitle);
      page.append(titleRow);

      const commandBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
      });
      page.append(commandBar);

      this.searchEntry = new Gtk.SearchEntry({
        placeholder_text: 'Search',
        width_request: 180,
      });
      this.searchEntry.connect('search-changed', () => {
        this.filters.query = this.searchEntry.get_text();
        this.loadIssues();
      });
      commandBar.append(this.searchEntry);

      const saveViewButton = makeIconLabelButton(
        'document-save-symbolic',
        'Save View',
      );
      saveViewButton.connect('clicked', () => {
        this.openSaveViewWindow();
      });
      commandBar.append(saveViewButton);

      this.exportButton = makeIconLabelButton(
        'document-send-symbolic',
        'Export to Multica',
      );
      this.exportButton.connect('clicked', () => {
        this.exportProjectToMultica();
      });
      commandBar.append(this.exportButton);

      const newButton = makeIconLabelButton('list-add-symbolic', 'New');
      newButton.connect('clicked', () => {
        this.addToast(
          'Manual issue creation is not implemented by the backend yet.',
        );
      });
      commandBar.append(newButton);

      const filters = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        valign: Gtk.Align.CENTER,
      });
      page.append(filters);

      filters.append(
        makeDropdown(STATUS_OPTIONS, this.filters.status, (value) => {
          this.filters.status = value;
          this.loadIssues();
        }),
      );
      filters.append(
        makeDropdown(PRIORITY_OPTIONS, this.filters.priority, (value) => {
          this.filters.priority = value;
          this.loadIssues();
        }),
      );
      filters.append(
        makeDropdown(PARSE_MODE_OPTIONS, this.filters.parseMode, (value) => {
          this.filters.parseMode = value;
          this.loadIssues();
        }),
      );

      this.reviewToggle = new Gtk.ToggleButton({ label: 'Review' });
      this.reviewToggle.connect('toggled', () => {
        this.filters.needsReview = this.reviewToggle.get_active();
        this.loadIssues();
      });
      filters.append(this.reviewToggle);

      this.commitsToggle = new Gtk.ToggleButton({ label: 'Commits' });
      this.commitsToggle.connect('toggled', () => {
        this.filters.hasCommits = this.commitsToggle.get_active();
        this.loadIssues();
      });
      filters.append(this.commitsToggle);

      this.tagsToggle = new Gtk.ToggleButton({ label: 'Tags' });
      this.tagsToggle.connect('toggled', () => {
        this.filters.hasTags = this.tagsToggle.get_active();
        this.loadIssues();
      });
      filters.append(this.tagsToggle);

      this.statusLabel = makeLabel('Starting local backend...', ['muted']);
      page.append(this.statusLabel);

      const headerRow = addCssClasses(
        new Gtk.Grid({
          column_spacing: 12,
          column_homogeneous: false,
        }),
        ['table-header'],
      );
      headerRow.attach(makeLabel('Title', ['section-title']), 0, 0, 1, 1);
      headerRow.attach(makeLabel('Status', ['section-title']), 1, 0, 1, 1);
      headerRow.attach(makeLabel('Priority', ['section-title']), 2, 0, 1, 1);
      headerRow.attach(makeLabel('Tags', ['section-title']), 3, 0, 1, 1);
      headerRow.attach(makeLabel('Sub', ['section-title']), 4, 0, 1, 1);
      headerRow.attach(makeLabel('Commits', ['section-title']), 5, 0, 1, 1);
      headerRow.attach(makeLabel('Updated', ['section-title']), 6, 0, 1, 1);
      page.append(headerRow);

      this.issueList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        vexpand: true,
      });
      this.issueList.add_css_class('boxed-list');
      this.issueList.connect('row-activated', (_list, row) => {
        if (row.issueId) {
          this.openIssue(row.issueId);
        }
      });
      page.append(this.issueList);
    }

    async start() {
      try {
        await this.startBackend();
        await this.loadInitialData();
      } catch (error) {
        this.showError(error);
      }
    }

    async startBackend() {
      const port = findAvailablePort();
      this.apiBaseUrl = `http://127.0.0.1:${port}/api`;
      const configuredDataDir = GLib.getenv(
        'CODEX_BOARDS_APP_DATA_DIR',
      )?.trim();
      const dataDir =
        configuredDataDir ||
        GLib.build_filenamev([GLib.get_user_data_dir(), 'codex-boards']);
      GLib.mkdir_with_parents(dataDir, 0o700);

      const spec = backendSpec();
      if (!spec) {
        throw new Error(
          'Could not find a Codex Boards backend. Build the sidecar or run from the repository with Bun on PATH.',
        );
      }

      const launcher = new Gio.SubprocessLauncher({
        flags:
          Gio.SubprocessFlags.STDOUT_SILENCE |
          Gio.SubprocessFlags.STDERR_SILENCE,
      });
      launcher.set_cwd(spec.cwd);
      launcher.setenv('PORT', String(port), true);
      launcher.setenv('CODEX_BOARDS_APP_DATA_DIR', dataDir, true);
      this.backendProcess = launcher.spawnv(spec.argv);

      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await requestJson(this.session, this.apiBaseUrl, 'GET', '/health');
          return;
        } catch {
          await delay(150);
        }
      }

      throw new Error(
        `Timed out waiting for the local backend on port ${port}`,
      );
    }

    async loadInitialData() {
      this.statusLabel.set_label('Loading projects...');
      const [projects, views, settings] = await Promise.all([
        this.getJson('/projects'),
        this.getJson('/views'),
        this.getJson('/settings'),
      ]);

      this.projectsResponse = projects;
      this.savedViewsResponse = views;
      this.settingsResponse = settings;
      this.selectedProjectId = projects.projects[0]?.id ?? null;

      this.renderProjects();
      this.renderSavedViews();
      this.updateProjectHeader();
      await this.loadIssues();
      this.statusLabel.set_label('Ready');
    }

    async getJson(path) {
      return await requestJson(this.session, this.apiBaseUrl, 'GET', path);
    }

    async postJson(path, body = undefined) {
      return await requestJson(
        this.session,
        this.apiBaseUrl,
        'POST',
        path,
        body,
      );
    }

    selectedProject() {
      return (
        this.projectsResponse?.projects.find(
          (project) => project.id === this.selectedProjectId,
        ) ?? null
      );
    }

    renderProjects() {
      clearChildren(this.projectList);

      for (const project of this.projectsResponse?.projects ?? []) {
        const row = new Gtk.ListBoxRow({ activatable: true });
        const content = new Gtk.Box({
          orientation: Gtk.Orientation.HORIZONTAL,
          spacing: 8,
          margin_top: 6,
          margin_bottom: 6,
          margin_start: 8,
          margin_end: 8,
        });
        content.append(
          makePill(project.name.charAt(0).toUpperCase(), 'neutral-pill'),
        );
        const labels = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 2,
        });
        labels.append(makeLabel(project.name));
        labels.append(
          makeLabel(
            `${project.issueCount} issues / ${project.needsReviewCount} review`,
            ['muted'],
          ),
        );
        content.append(labels);
        row.set_child(content);
        row.connect('activate', () => {
          this.selectedProjectId = project.id;
          this.updateProjectHeader();
          this.renderProjects();
          this.loadIssues();
        });
        if (project.id === this.selectedProjectId) {
          row.add_css_class('accent');
        }
        this.projectList.append(row);
      }
    }

    renderSavedViews() {
      clearChildren(this.savedViewList);

      const views = this.savedViewsResponse?.views ?? [];
      if (views.length === 0) {
        const row = new Gtk.ListBoxRow({ selectable: false });
        row.set_child(makeLabel('No saved views yet', ['muted']));
        this.savedViewList.append(row);
        return;
      }

      for (const view of views) {
        const row = new Gtk.ListBoxRow({ activatable: true });
        row.set_child(makeLabel(view.name));
        row.connect('activate', () => {
          this.filters = {
            status: 'all',
            priority: 'all',
            parseMode: 'all',
            query: '',
            needsReview: false,
            hasCommits: false,
            hasTags: false,
            ...view.filters,
          };
          this.syncFilterControls();
          this.loadIssues();
        });
        this.savedViewList.append(row);
      }
    }

    syncFilterControls() {
      this.searchEntry.set_text(this.filters.query ?? '');
      this.reviewToggle.set_active(Boolean(this.filters.needsReview));
      this.commitsToggle.set_active(Boolean(this.filters.hasCommits));
      this.tagsToggle.set_active(Boolean(this.filters.hasTags));
    }

    updateProjectHeader() {
      const project = this.selectedProject();
      const name = project?.name ?? 'Select a project';
      this.projectTitle.set_label(name);
      this.projectBadge.set_label(project?.name.charAt(0).toUpperCase() ?? 'P');
      this.breadcrumbLabel.set_label(`Projects / ${name}`);
      this.exportButton.set_sensitive(Boolean(project));
    }

    async loadIssues() {
      if (!this.selectedProjectId || !this.apiBaseUrl) {
        clearChildren(this.issueList);
        this.statusLabel.set_label('Select a project to load issues.');
        return;
      }

      try {
        this.statusLabel.set_label('Loading issues...');
        const path = buildIssuePath(this.selectedProjectId, this.filters);
        this.issuesResponse = await this.getJson(path);
        this.renderIssues();
        const count = this.issuesResponse.issues.length;
        this.statusLabel.set_label(
          `${count} issue${count === 1 ? '' : 's'} shown`,
        );
      } catch (error) {
        this.showError(error);
      }
    }

    renderIssues() {
      clearChildren(this.issueList);

      const issues = this.issuesResponse?.issues ?? [];
      if (issues.length === 0) {
        const row = new Gtk.ListBoxRow({ selectable: false });
        const message = this.selectedProjectId
          ? 'No issues match the current filters.'
          : 'Select a project to load issues.';
        row.set_child(makeLabel(message, ['muted']));
        this.issueList.append(row);
        return;
      }

      for (const issue of issues) {
        const row = addCssClasses(new Gtk.ListBoxRow({ activatable: true }), [
          'issue-row',
        ]);
        row.issueId = issue.id;

        const grid = new Gtk.Grid({ column_spacing: 12, row_spacing: 4 });
        grid.attach(makeLabel(issue.title), 0, 0, 1, 1);
        grid.attach(makePill(formatLabel(issue.status)), 1, 0, 1, 1);
        grid.attach(
          makePill(formatLabel(issue.priority), 'neutral-pill'),
          2,
          0,
          1,
          1,
        );
        grid.attach(
          makeLabel(issue.tags.slice(0, 3).join(', ') || 'None', ['muted']),
          3,
          0,
          1,
          1,
        );
        grid.attach(makeLabel(String(issue.subIssueCount)), 4, 0, 1, 1);
        grid.attach(makeLabel(String(issue.git.commits.length)), 5, 0, 1, 1);
        grid.attach(
          makeLabel(formatDate(issue.updatedAt), ['muted']),
          6,
          0,
          1,
          1,
        );

        row.set_child(grid);
        this.issueList.append(row);
      }
    }

    async runSync() {
      this.syncButton.set_sensitive(false);
      this.statusLabel.set_label('Syncing rollout history...');

      try {
        const response = await this.postJson('/sync');
        const [projects, settings] = await Promise.all([
          this.getJson('/projects'),
          this.getJson('/settings'),
        ]);
        this.projectsResponse = { ...projects, sync: response.sync };
        this.settingsResponse = settings;

        if (!this.selectedProjectId) {
          this.selectedProjectId = projects.projects[0]?.id ?? null;
        }

        this.renderProjects();
        this.updateProjectHeader();
        await this.loadIssues();
        this.addToast('Sync complete');
      } catch (error) {
        this.showError(error);
      } finally {
        this.syncButton.set_sensitive(true);
      }
    }

    async openIssue(issueId) {
      try {
        const response = await this.getJson(
          `/issues/${encodeURIComponent(issueId)}`,
        );
        if (!response.issue) {
          this.addToast('Issue not found');
          return;
        }
        this.openIssueWindow(response.issue);
      } catch (error) {
        this.showError(error);
      }
    }

    openIssueWindow(issue) {
      const window = new Adw.Window({
        transient_for: this,
        title: issue.title,
        default_width: 760,
        default_height: 820,
      });
      const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      const header = new Adw.HeaderBar();
      const reviewButton = makeIconLabelButton(
        issue.needsReview ? 'object-select-symbolic' : 'mail-send-symbolic',
        issue.needsReview ? 'Mark Reviewed' : 'Send to Review',
      );
      reviewButton.connect('clicked', async () => {
        try {
          const payload = await this.postJson(
            `/issues/${encodeURIComponent(issue.id)}/review`,
            {
              needsReview: !issue.needsReview,
            },
          );
          window.close();
          await this.loadIssues();
          if (payload.issue) {
            this.openIssueWindow(payload.issue);
          }
        } catch (error) {
          this.showError(error);
        }
      });
      header.pack_end(reviewButton);
      root.append(header);

      const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
      });
      const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 18,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
      });
      scrolled.set_child(content);
      root.append(scrolled);
      window.set_content(root);

      content.append(
        makeLabel(issue.kind === 'parent' ? 'Parent issue' : 'Sub issue', [
          'section-title',
        ]),
      );
      content.append(makeLabel(issue.title, ['heading']));
      content.append(this.makeIssueSummaryGrid(issue));

      content.append(makeLabel('Summary', ['section-title']));
      content.append(makeLabel(issue.summary));

      content.append(makeLabel('Tags', ['section-title']));
      const tags = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 6,
        row_spacing: 6,
      });
      if (issue.tags.length > 0) {
        for (const tag of issue.tags) {
          tags.append(makePill(tag, 'neutral-pill'));
        }
      } else {
        tags.append(makeLabel('No tags', ['muted']));
      }
      content.append(tags);

      content.append(makeLabel('Git evidence', ['section-title']));
      content.append(makeLabel(`Repository: ${issue.git.repository}`));
      content.append(
        makeLabel(`Workspace: ${issue.git.workspacePath}`, ['muted']),
      );
      content.append(
        makeLabel(`Branch: ${issue.git.branch ?? 'Unknown'}`, ['muted']),
      );
      content.append(
        makeLabel(`Commits: ${issue.git.commits.length}`, ['muted']),
      );

      content.append(makeLabel('Traceability', ['section-title']));
      content.append(makeLabel(`Thread: ${issue.threadId}`, ['muted']));
      content.append(
        makeLabel(`Rollout: ${issue.evidence.rolloutPath}`, ['muted']),
      );
      content.append(
        makeLabel(`Updated: ${formatDate(issue.updatedAt)}`, ['muted']),
      );

      if (issue.evidence.warnings.length > 0) {
        content.append(
          makeLabel(`Warnings: ${issue.evidence.warnings.join('\n')}`),
        );
      }

      content.append(makeLabel('Parse payload preview', ['section-title']));
      content.append(
        addCssClasses(makeLabel(issue.evidence.parsePayloadPreview), [
          'preview',
        ]),
      );

      content.append(makeLabel('Sub issues', ['section-title']));
      if (issue.children?.length > 0) {
        for (const child of issue.children) {
          const childRow = new Adw.ActionRow({
            title: child.title,
            subtitle: child.summary,
          });
          childRow.add_suffix(makePill(formatLabel(child.status)));
          childRow.add_suffix(
            makePill(formatLabel(child.priority), 'neutral-pill'),
          );
          content.append(childRow);
        }
      } else {
        content.append(
          makeLabel('No sub issues extracted for this thread.', ['muted']),
        );
      }

      window.present();
    }

    makeIssueSummaryGrid(issue) {
      const grid = new Gtk.Grid({
        column_spacing: 16,
        row_spacing: 8,
      });
      const fields = [
        ['Status', formatLabel(issue.status)],
        ['Priority', formatLabel(issue.priority)],
        ['Parse mode', issue.parseMode],
        ['Confidence', `${Math.round(issue.confidence * 100)}%`],
        ['Assignee', issue.assignee ?? 'Unassigned'],
        ['Due date', issue.dueDate ?? 'Unset'],
      ];

      fields.forEach(([name, value], index) => {
        const row = Math.floor(index / 2);
        const col = (index % 2) * 2;
        grid.attach(makeLabel(name, ['section-title']), col, row, 1, 1);
        grid.attach(
          makePill(value, index < 4 ? 'pill' : 'neutral-pill'),
          col + 1,
          row,
          1,
          1,
        );
      });

      return grid;
    }

    openSettingsWindow() {
      const settings = this.settingsResponse;
      const window = new Adw.PreferencesWindow({
        transient_for: this,
        modal: true,
        title: 'Settings',
        default_width: 760,
        default_height: 640,
      });

      const parserPage = new Adw.PreferencesPage({
        title: 'Parser',
        icon_name: 'emblem-system-symbolic',
      });
      const parserGroup = new Adw.PreferencesGroup({
        title: 'Parser configuration',
        description: 'OpenAI-compatible parser target for the next sync run.',
      });
      parserPage.add(parserGroup);

      const baseUrlRow = new Adw.EntryRow({
        title: 'Base URL',
        text: settings?.parser.baseUrl ?? '',
      });
      const modelRow = new Adw.EntryRow({
        title: 'Model',
        text: settings?.parser.model ?? '',
      });
      const apiKeyRow = new Adw.PasswordEntryRow({
        title: 'API key',
        text: '',
      });
      apiKeyRow.set_show_apply_button(false);
      parserGroup.add(baseUrlRow);
      parserGroup.add(modelRow);
      parserGroup.add(apiKeyRow);
      parserGroup.add(
        new Adw.ActionRow({
          title: settings?.parser.apiKeyConfigured
            ? 'API key is already stored'
            : 'API key is missing',
          subtitle: 'Enter a value above only when replacing the stored key.',
        }),
      );

      const presetGroup = new Adw.PreferencesGroup({ title: 'Presets' });
      parserPage.add(presetGroup);
      for (const [id, preset] of Object.entries(PARSER_PRESETS)) {
        const row = new Adw.ActionRow({
          title: preset.label,
          subtitle: `${preset.baseUrl} / ${preset.model}`,
        });
        const button = new Gtk.Button({ label: 'Apply' });
        button.connect('clicked', () => {
          baseUrlRow.set_text(PARSER_PRESETS[id].baseUrl);
          modelRow.set_text(PARSER_PRESETS[id].model);
        });
        row.add_suffix(button);
        presetGroup.add(row);
      }

      const statusGroup = new Adw.PreferencesGroup({ title: 'Status' });
      parserPage.add(statusGroup);
      statusGroup.add(
        new Adw.ActionRow({
          title: settings?.parser.apiKeyConfigured
            ? 'API key configured'
            : 'API key missing',
          subtitle: settings?.sync
            ? `Last sync ${formatDate(settings.sync.completedAt)}`
            : 'No sync recorded yet',
        }),
      );
      const saveRow = new Adw.ActionRow({
        title: 'Save parser settings',
        subtitle: 'Leave fields empty to use deterministic fallback parsing.',
      });
      const saveButton = addCssClasses(
        new Gtk.Button({ label: 'Save Settings' }),
        ['suggested-action'],
      );
      saveButton.connect('clicked', async () => {
        try {
          const payload = {
            parser: {
              baseUrl: baseUrlRow.get_text(),
              model: modelRow.get_text(),
            },
          };
          const apiKey = apiKeyRow.get_text().trim();
          if (apiKey) {
            payload.parser.apiKey = apiKey;
          }

          this.settingsResponse = await this.postJson('/settings', payload);
          this.addToast('Settings saved');
          window.close();
        } catch (error) {
          this.showError(error);
        }
      });
      saveRow.add_suffix(saveButton);
      statusGroup.add(saveRow);

      const historyPage = new Adw.PreferencesPage({
        title: 'Sync History',
        icon_name: 'view-refresh-symbolic',
      });
      const historyGroup = new Adw.PreferencesGroup({
        title: 'Recent sync runs',
        description: 'Parser target, token use, imported threads, and errors.',
      });
      historyPage.add(historyGroup);

      const syncHistory = settings?.syncHistory ?? [];
      if (syncHistory.length === 0) {
        historyGroup.add(
          new Adw.ActionRow({
            title: 'No sync history recorded yet',
            subtitle: 'Run Sync to populate this page.',
          }),
        );
      } else {
        for (const entry of syncHistory) {
          historyGroup.add(
            new Adw.ActionRow({
              title: formatDate(entry.completedAt),
              subtitle: `${entry.parserModel ?? 'Fallback only'} / ${entry.tokenUsage.totalTokens || 'n/a'} tokens / ${entry.importedThreads} imported / ${entry.errors.length} errors`,
            }),
          );
        }
      }

      window.add(parserPage);
      window.add(historyPage);
      window.present();
    }

    openSaveViewWindow() {
      const window = new Adw.Window({
        transient_for: this,
        modal: true,
        title: 'Save View',
        default_width: 420,
        default_height: 160,
      });
      const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 18,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
      });
      const entry = new Gtk.Entry({ placeholder_text: 'View name' });
      const buttons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
      });
      const cancel = new Gtk.Button({ label: 'Cancel' });
      const save = addCssClasses(new Gtk.Button({ label: 'Save' }), [
        'suggested-action',
      ]);
      cancel.connect('clicked', () => window.close());
      save.connect('clicked', async () => {
        const name = entry.get_text().trim();
        if (!name) {
          return;
        }

        try {
          this.savedViewsResponse = await this.postJson('/views', {
            name,
            filters: this.filters,
          });
          this.renderSavedViews();
          this.addToast('View saved');
          window.close();
        } catch (error) {
          this.showError(error);
        }
      });
      buttons.append(cancel);
      buttons.append(save);
      root.append(makeLabel('Save the current filters as a reusable view.'));
      root.append(entry);
      root.append(buttons);
      window.set_content(root);
      window.present();
    }

    async exportProjectToMultica() {
      if (!this.selectedProjectId) {
        return;
      }

      this.exportButton.set_sensitive(false);

      try {
        const response = await this.postJson('/export/multica', {
          projectId: this.selectedProjectId,
          includeChildren: true,
          runSync: false,
        });
        const skipped =
          response.skippedChildren.length > 0
            ? ` ${response.skippedChildren.length} child issues were skipped.`
            : '';
        this.addToast(
          `Exported ${response.exported.length} issues to Multica.${skipped}`,
        );
      } catch (error) {
        this.showError(error);
      } finally {
        this.exportButton.set_sensitive(true);
      }
    }

    addToast(title) {
      this.toastOverlay.add_toast(new Adw.Toast({ title: String(title) }));
    }

    showError(error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusLabel.set_label(message);
      this.addToast(message);
    }

    shutdownBackend() {
      if (this.backendProcess) {
        this.backendProcess.force_exit();
        this.backendProcess = null;
      }
    }
  },
);

const CodexBoardsApplication = GObject.registerClass(
  class CodexBoardsApplication extends Adw.Application {
    _init() {
      super._init({
        application_id: APP_ID,
        flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
      });
    }

    vfunc_activate() {
      if (!this.window) {
        this.window = new BoardsWindow(this);
      }
      this.window.present();
    }

    vfunc_shutdown() {
      this.window?.shutdownBackend();
      super.vfunc_shutdown();
    }
  },
);

const app = new CodexBoardsApplication();
app.run(ARGV);
