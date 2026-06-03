use std::{
    env::consts::EXE_SUFFIX,
    fs::create_dir_all,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, State};

struct BackendState {
    api_base_url: String,
    process: Mutex<Option<Child>>,
}

#[tauri::command]
fn get_api_base_url(state: State<'_, BackendState>) -> String {
    state.api_base_url.clone()
}

fn repo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .map_err(|error| format!("failed to resolve repo root: {error}"))
}

fn resolve_backend_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve desktop resources: {error}"))?;
    let binary_name = format!("codex-boards-backend{EXE_SUFFIX}");
    let candidates = [
        resource_dir.join("backend").join(&binary_name),
        resource_dir.join("resources").join("backend").join(&binary_name),
        resource_dir
            .join("../resources")
            .join("backend")
            .join(&binary_name),
    ];

    for candidate in candidates {
        if candidate.is_file() {
            return candidate.canonicalize().map_err(|error| {
                format!(
                    "failed to canonicalize bundled backend binary {}: {error}",
                    candidate.display()
                )
            });
        }
    }

    Err(format!(
        "failed to resolve bundled backend binary under {}",
        resource_dir.display()
    ))
}

fn reserve_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("failed to reserve backend port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read reserved backend port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_backend(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);

    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }

        sleep(Duration::from_millis(150));
    }

    Err(format!(
        "timed out waiting for the backend to accept connections on port {port}"
    ))
}

fn spawn_backend(app: &AppHandle) -> Result<BackendState, String> {
    let port = reserve_port()?;
    let api_base_url = format!("http://127.0.0.1:{port}/api");
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    create_dir_all(&app_data_dir)
        .map_err(|error| format!("failed to create app data dir: {error}"))?;

    let mut command = if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .current_dir(repo_root()?)
            .arg("apps/backend/src/index.ts")
            .arg("serve");
        command
    } else {
        let mut command = Command::new(resolve_backend_binary(app)?);
        command.arg("serve");
        command
    };

    command
        .env("PORT", port.to_string())
        .env("CODEX_BOARDS_APP_DATA_DIR", app_data_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let child = command
        .spawn()
        .map_err(|error| format!("failed to launch the bundled backend: {error}"))?;

    wait_for_backend(port)?;

    Ok(BackendState {
        api_base_url,
        process: Mutex::new(Some(child)),
    })
}

fn shutdown_backend(app: &AppHandle) {
    let state = app.state::<BackendState>();
    if let Ok(mut process) = state.process.lock() {
        if let Some(child) = process.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *process = None;
    };
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let backend_state = spawn_backend(app.handle())?;
            app.manage(backend_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_base_url])
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                shutdown_backend(app);
            }
        });
}
