# Prebuilt Rust API (optional)

Place `tkb_rust_api.exe` here when you cannot build locally (missing MSVC Build Tools).

`scripts/setup.ps1` and `start.py` will copy this file to `target/release/` automatically.

Build on a machine with Rust + MSVC:

```powershell
cd rust_api
cargo build --release
copy target\release\tkb_rust_api.exe prebuilt\
```
