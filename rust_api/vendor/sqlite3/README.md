# SQLite runtime for the Windows GNU build

`sqlite3.lib` is the x86-64 COFF import library used by the bundled Rust GNU
toolchain. `sqlite3.dll` is placed beside `tkb_rust_api.exe` by `start.py` so a
clean Windows machine can build and launch the backend without a separate
SQLite SDK or Visual Studio installation.

`sqlite3.def` records the exported SQLite API used to regenerate the import
library. The three exported data symbols are explicitly marked `DATA`; treating
them as functions causes the backend to crash during database initialization.

The SQLite library is public domain. The runtime is the official SQLite 3.50.4
Windows x64 build. Do not replace it with Python's private `sqlite3.dll`: that
binary can load but crash the GNU backend during database initialization.
