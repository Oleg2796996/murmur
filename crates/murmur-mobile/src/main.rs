// murmur-mobile binary entry point.
// Active only when built with `tauri-runtime` feature.
#![cfg_attr(
    not(feature = "tauri-runtime"),
    allow(dead_code, unused_imports)
)]

#[cfg(feature = "tauri-runtime")]
fn main() {
    murmur_mobile_lib::run();
}

#[cfg(not(feature = "tauri-runtime"))]
fn main() {
    eprintln!("murmur-mobile binary requires --features tauri-runtime to build.");
    eprintln!("Use `cargo tauri build` from a host with webview SDK installed.");
    std::process::exit(2);
}