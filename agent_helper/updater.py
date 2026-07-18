"""Authenticated, user-confirmed updates for the packaged Windows Agent."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping
from urllib.parse import urljoin, urlsplit

from .relocation import INSTALL_EXE_NAME
from .state import default_state_dir


RELEASE_PROTOCOL = "tkb-agent-release-v1"
RELEASE_MANIFEST_PATH = "/downloads/TKBCherryAgent-release.json"
RELEASE_ARCHIVE_PATH = "/downloads/TKBCherryAgent-Windows.zip"
SIGNATURE_ALGORITHM = "rsa-pkcs1-sha256"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024

# This public key is safe to ship. Its DPAPI-protected private counterpart is
# kept only in the release operator's Windows profile and is never uploaded.
RELEASE_PUBLIC_EXPONENT = 65537
RELEASE_PUBLIC_MODULUS_B64URL = (
    "5Exq33A2kBoPLm5y2oQBvHACAZTh5pQBLY-8LanrrLDOiDiWY_SwsnfJoKC34Lyv4Kqa3ioz"
    "rxe7kkanPBROs4vMrPJ6wGZzrfr99rfNUdPnigwTUYPJ7ATbL2pQ3eyPq6mWfbUf0jUhYacq"
    "fTwXTojjOSey8ph2hxOoZ6wruMrRltyyIxnQOh5gWmYT-P8b7sOOujJPEM331A8QRYN23uSs"
    "1RitwCET9e29gO-rOqARHk3kOtO_CIKbE5bOWzgpmun-i1IzbXt3ioNE7qNi5jsR-8CWsHGn"
    "z2aBYl8Dty4qEcXobZwt5ORbnUjmNFQvGlLj6vzoEXlC7SjvsiRTuH_mfPqc7rdGLXNVmRj-"
    "rSlvMnCAXHFW_eUbl0bJ0y-eTKpaSpSeoLf8HPfg9Bdvp-51dqxYfbAeByfN20v03ApUTMpl"
    "PDPvLR996dc9iH4LwrA7F0tmzf5i5m_rPK77QnuwtIALPHeOwKGOy8iACBtn8W89jrYgzgAw"
    "jYZTgBlT"
)

_VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PUBLISHED_AT_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


class UpdateError(RuntimeError):
    """Raised when an update is unsafe, malformed, or unavailable."""


@dataclass(frozen=True, slots=True)
class ReleaseManifest:
    version: str
    published_at: str
    archive_url: str
    archive_sha256: str
    archive_size: int
    executable_sha256: str
    executable_size: int
    signature: str

    def signed_payload(self) -> dict[str, object]:
        return {
            "archiveSha256": self.archive_sha256,
            "archiveSize": self.archive_size,
            "archiveUrl": self.archive_url,
            "executableSha256": self.executable_sha256,
            "executableSize": self.executable_size,
            "protocol": RELEASE_PROTOCOL,
            "publishedAt": self.published_at,
            "signatureAlgorithm": SIGNATURE_ALGORITHM,
            "version": self.version,
        }


def parse_version(value: str) -> tuple[int, int, int]:
    match = _VERSION_RE.fullmatch(str(value or ""))
    if match is None:
        raise UpdateError("release version must use major.minor.patch")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def is_newer_version(candidate: str, current: str) -> bool:
    return parse_version(candidate) > parse_version(current)


def canonical_release_payload(payload: Mapping[str, object]) -> bytes:
    return json.dumps(
        dict(payload),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _decode_b64url(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as exc:
        raise UpdateError("release signature is not valid base64") from exc


def verify_rsa_pkcs1_sha256(
    payload: bytes,
    signature: bytes,
    *,
    modulus_b64url: str = RELEASE_PUBLIC_MODULUS_B64URL,
    exponent: int = RELEASE_PUBLIC_EXPONENT,
) -> bool:
    modulus_bytes = _decode_b64url(modulus_b64url)
    modulus = int.from_bytes(modulus_bytes, "big")
    key_bytes = (modulus.bit_length() + 7) // 8
    if exponent < 3 or len(signature) != key_bytes:
        return False
    signature_number = int.from_bytes(signature, "big")
    if signature_number <= 0 or signature_number >= modulus:
        return False
    encoded = pow(signature_number, exponent, modulus).to_bytes(key_bytes, "big")
    digest_info = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(payload).digest()
    padding_length = key_bytes - len(digest_info) - 3
    if padding_length < 8:
        return False
    expected = b"\x00\x01" + (b"\xff" * padding_length) + b"\x00" + digest_info
    return hmac.compare_digest(encoded, expected)


def _required_text(raw: Mapping[str, Any], key: str, maximum: int = 512) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise UpdateError(f"release field {key} is invalid")
    return value


def _required_size(raw: Mapping[str, Any], key: str, maximum: int) -> int:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise UpdateError(f"release field {key} is invalid")
    return value


def parse_release_manifest(raw_bytes: bytes) -> ReleaseManifest:
    if not raw_bytes or len(raw_bytes) > MAX_MANIFEST_BYTES:
        raise UpdateError("release manifest has an invalid size")
    try:
        raw = json.loads(raw_bytes.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise UpdateError("release manifest is not valid JSON") from exc
    if not isinstance(raw, dict):
        raise UpdateError("release manifest must be an object")
    expected_keys = {
        "archiveSha256",
        "archiveSize",
        "archiveUrl",
        "executableSha256",
        "executableSize",
        "protocol",
        "publishedAt",
        "signature",
        "signatureAlgorithm",
        "version",
    }
    if set(raw) != expected_keys:
        raise UpdateError("release manifest fields do not match the update protocol")
    if raw.get("protocol") != RELEASE_PROTOCOL:
        raise UpdateError("release manifest protocol is unsupported")
    if raw.get("signatureAlgorithm") != SIGNATURE_ALGORITHM:
        raise UpdateError("release signature algorithm is unsupported")
    version = _required_text(raw, "version", 32)
    parse_version(version)
    published_at = _required_text(raw, "publishedAt", 32)
    if _PUBLISHED_AT_RE.fullmatch(published_at) is None:
        raise UpdateError("release publication time is invalid")
    archive_url = _required_text(raw, "archiveUrl", 1024)
    archive_sha256 = _required_text(raw, "archiveSha256", 64)
    executable_sha256 = _required_text(raw, "executableSha256", 64)
    if _SHA256_RE.fullmatch(archive_sha256) is None or _SHA256_RE.fullmatch(executable_sha256) is None:
        raise UpdateError("release SHA-256 is invalid")
    manifest = ReleaseManifest(
        version=version,
        published_at=published_at,
        archive_url=archive_url,
        archive_sha256=archive_sha256,
        archive_size=_required_size(raw, "archiveSize", MAX_ARCHIVE_BYTES),
        executable_sha256=executable_sha256,
        executable_size=_required_size(raw, "executableSize", MAX_EXECUTABLE_BYTES),
        signature=_required_text(raw, "signature", 2048),
    )
    signature = _decode_b64url(manifest.signature)
    if not verify_rsa_pkcs1_sha256(
        canonical_release_payload(manifest.signed_payload()), signature
    ):
        raise UpdateError("release manifest signature is invalid")
    return manifest


def _same_origin(left: str, right: str) -> bool:
    a = urlsplit(left)
    b = urlsplit(right)
    return (a.scheme.casefold(), a.hostname, a.port) == (
        b.scheme.casefold(),
        b.hostname,
        b.port,
    )


def _validate_release_url(
    manifest_url: str,
    archive_url: str,
    *,
    allow_local_http: bool,
) -> str:
    absolute = urljoin(manifest_url, archive_url)
    parsed = urlsplit(absolute)
    manifest = urlsplit(manifest_url)
    if parsed.username or parsed.password or parsed.fragment:
        raise UpdateError("release download URL is unsafe")
    if not _same_origin(manifest_url, absolute):
        raise UpdateError("release download must use the manifest origin")
    if parsed.path != RELEASE_ARCHIVE_PATH:
        raise UpdateError("release download path is unexpected")
    loopback = (parsed.hostname or "").casefold() in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (allow_local_http and parsed.scheme == "http" and loopback):
        raise UpdateError("release download must use HTTPS")
    return absolute


def _request_bytes(
    url: str,
    *,
    timeout_seconds: float,
    maximum_bytes: int,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "TKBCherryAgent-Updater/1"},
        method="GET",
    )
    try:
        with opener(request, timeout=timeout_seconds) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > maximum_bytes:
                        raise UpdateError("release response is too large")
                except ValueError as exc:
                    raise UpdateError("release response length is invalid") from exc
            payload = response.read(maximum_bytes + 1)
    except UpdateError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise UpdateError("could not contact the update server") from exc
    if len(payload) > maximum_bytes:
        raise UpdateError("release response is too large")
    return payload


def _copy_exact_with_digest(
    source: BinaryIO,
    destination: BinaryIO,
    *,
    expected_size: int,
    expected_sha256: str,
) -> None:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = source.read(DOWNLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > expected_size:
            raise UpdateError("release file is larger than declared")
        digest.update(chunk)
        destination.write(chunk)
    if total != expected_size:
        raise UpdateError("release file size does not match the manifest")
    if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
        raise UpdateError("release file SHA-256 does not match the manifest")


def _path_matches_digest(path: Path, *, expected_size: int, expected_sha256: str) -> bool:
    try:
        if path.stat().st_size != expected_size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(DOWNLOAD_CHUNK_BYTES):
                digest.update(chunk)
        return hmac.compare_digest(digest.hexdigest(), expected_sha256)
    except OSError:
        return False


def _download_archive(
    url: str,
    destination: Path,
    manifest: ReleaseManifest,
    *,
    timeout_seconds: float,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> None:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/zip", "User-Agent": "TKBCherryAgent-Updater/1"},
        method="GET",
    )
    try:
        with opener(request, timeout=timeout_seconds) as response, destination.open("xb") as output:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) != manifest.archive_size:
                        raise UpdateError("release archive length does not match the manifest")
                except ValueError as exc:
                    raise UpdateError("release archive length is invalid") from exc
            _copy_exact_with_digest(
                response,
                output,
                expected_size=manifest.archive_size,
                expected_sha256=manifest.archive_sha256,
            )
            output.flush()
            os.fsync(output.fileno())
    except UpdateError:
        destination.unlink(missing_ok=True)
        raise
    except (OSError, urllib.error.URLError) as exc:
        destination.unlink(missing_ok=True)
        raise UpdateError("could not download the Agent update") from exc


def _extract_verified_executable(
    archive_path: Path,
    destination: Path,
    manifest: ReleaseManifest,
) -> None:
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            entries = archive.infolist()
            if len(entries) != 1:
                raise UpdateError("release archive must contain exactly one file")
            entry = entries[0]
            if entry.is_dir() or entry.filename != INSTALL_EXE_NAME:
                raise UpdateError("release archive contains an unexpected path")
            if entry.file_size != manifest.executable_size:
                raise UpdateError("release executable size does not match the manifest")
            with archive.open(entry, "r") as source, destination.open("xb") as output:
                _copy_exact_with_digest(
                    source,
                    output,
                    expected_size=manifest.executable_size,
                    expected_sha256=manifest.executable_sha256,
                )
                output.flush()
                os.fsync(output.fileno())
    except UpdateError:
        destination.unlink(missing_ok=True)
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        destination.unlink(missing_ok=True)
        raise UpdateError("release archive could not be opened safely") from exc


def _default_spawn(executable: Path) -> None:
    creation_flags = 0
    if os.name == "nt":
        creation_flags = int(getattr(subprocess, "DETACHED_PROCESS", 0)) | int(
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    kwargs: dict[str, object] = {"cwd": str(executable.parent), "close_fds": True}
    if creation_flags:
        kwargs["creationflags"] = creation_flags
    subprocess.Popen([str(executable)], **kwargs)


def _default_smoke(executable: Path) -> bool:
    creation_flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) if os.name == "nt" else 0
    try:
        result = subprocess.run(
            [str(executable), "--gui-smoke"],
            cwd=str(executable.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=False,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _default_version_probe(executable: Path) -> str | None:
    creation_flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) if os.name == "nt" else 0
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            cwd=str(executable.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or len(result.stdout) > 4096 or len(result.stderr) > 4096:
        return None
    try:
        output = result.stdout.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return None
    match = re.fullmatch(r"TKBCherryAgent ([0-9]+\.[0-9]+\.[0-9]+)", output)
    return match.group(1) if match is not None else None


class AgentUpdater:
    """Check and stage authenticated releases without touching the running EXE."""

    def __init__(
        self,
        *,
        current_version: str,
        manifest_url: str,
        allow_local_http: bool = False,
        timeout_seconds: float = 35.0,
        state_dir: Path | None = None,
        opener: Callable[..., Any] = urllib.request.urlopen,
        smoke_runner: Callable[[Path], bool] = _default_smoke,
        version_probe: Callable[[Path], str | None] = _default_version_probe,
        spawn_process: Callable[[Path], None] = _default_spawn,
    ) -> None:
        parse_version(current_version)
        self.current_version = current_version
        self.manifest_url = manifest_url
        self.allow_local_http = bool(allow_local_http)
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 300.0))
        self.state_dir = state_dir or default_state_dir()
        self.opener = opener
        self.smoke_runner = smoke_runner
        self.version_probe = version_probe
        self.spawn_process = spawn_process

    @classmethod
    def for_api_base(
        cls,
        api_base: str,
        *,
        current_version: str,
        allow_local_http: bool = False,
        timeout_seconds: float = 35.0,
    ) -> "AgentUpdater":
        parsed = urlsplit(api_base)
        if not parsed.scheme or not parsed.netloc:
            raise UpdateError("Agent API URL cannot be used for updates")
        origin = f"{parsed.scheme}://{parsed.netloc}"
        return cls(
            current_version=current_version,
            manifest_url=origin + RELEASE_MANIFEST_PATH,
            allow_local_http=allow_local_http,
            timeout_seconds=timeout_seconds,
        )

    def check(self) -> ReleaseManifest | None:
        manifest = parse_release_manifest(
            _request_bytes(
                self.manifest_url,
                timeout_seconds=self.timeout_seconds,
                maximum_bytes=MAX_MANIFEST_BYTES,
                opener=self.opener,
            )
        )
        if not is_newer_version(manifest.version, self.current_version):
            return None
        _validate_release_url(
            self.manifest_url,
            manifest.archive_url,
            allow_local_http=self.allow_local_http,
        )
        return manifest

    def prepare_and_launch(self, manifest: ReleaseManifest) -> Path:
        if not is_newer_version(manifest.version, self.current_version):
            raise UpdateError("release is not newer than the running Agent")
        archive_url = _validate_release_url(
            self.manifest_url,
            manifest.archive_url,
            allow_local_http=self.allow_local_http,
        )
        update_root = self.state_dir / "updates"
        stage = update_root / f"{manifest.version}-{uuid.uuid4().hex}"
        archive_path = stage / "release.zip"
        executable_path = stage / INSTALL_EXE_NAME
        try:
            stage.mkdir(parents=True, exist_ok=False)
            _download_archive(
                archive_url,
                archive_path,
                manifest,
                timeout_seconds=self.timeout_seconds,
                opener=self.opener,
            )
            _extract_verified_executable(archive_path, executable_path, manifest)
            archive_path.unlink(missing_ok=True)
            if not self.smoke_runner(executable_path):
                raise UpdateError("the downloaded Agent failed its startup check")
            if not _path_matches_digest(
                executable_path,
                expected_size=manifest.executable_size,
                expected_sha256=manifest.executable_sha256,
            ):
                raise UpdateError("the staged Agent changed during its startup check")
            if self.version_probe(executable_path) != manifest.version:
                raise UpdateError("the staged Agent version does not match the release")
            if not _path_matches_digest(
                executable_path,
                expected_size=manifest.executable_size,
                expected_sha256=manifest.executable_sha256,
            ):
                raise UpdateError("the staged Agent changed during its version check")
            self.spawn_process(executable_path)
            return executable_path
        except UpdateError:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(stage, ignore_errors=True)
            raise UpdateError("could not stage the Agent update") from exc

    def cleanup_stale_updates(self, *, keep: Path | None = None) -> None:
        root = self.state_dir / "updates"
        try:
            children = list(root.iterdir())
        except (FileNotFoundError, OSError):
            return
        keep_resolved = keep.resolve(strict=False) if keep is not None else None
        for child in children:
            try:
                if keep_resolved is not None and child.resolve(strict=False) == keep_resolved:
                    continue
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
            except OSError:
                continue


def running_from_staged_update(executable: Path | None = None) -> Path | None:
    """Return the update stage directory when this process was launched there."""

    candidate = Path(sys.executable if executable is None else executable)
    updates_root = (default_state_dir() / "updates").resolve(strict=False)
    try:
        resolved_parent = candidate.parent.resolve(strict=False)
        if resolved_parent.parent == updates_root and candidate.name == INSTALL_EXE_NAME:
            return resolved_parent
    except OSError:
        return None
    return None
