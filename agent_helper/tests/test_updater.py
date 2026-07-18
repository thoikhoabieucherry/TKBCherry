from __future__ import annotations

import base64
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from agent_helper.updater import (
    RELEASE_ARCHIVE_PATH,
    RELEASE_PROTOCOL,
    SIGNATURE_ALGORITHM,
    AgentUpdater,
    ReleaseManifest,
    UpdateError,
    is_newer_version,
    parse_release_manifest,
    verify_rsa_pkcs1_sha256,
)


TEST_VECTOR_SIGNATURE = (
    "EPsYSW10XP3yOrcy8aOpsrKuG7Ylw6NKf7uWwDaS3cOPBGjQQopbW5JMe7YVSXA2RQCVF8TSUSakch8phJW7_"
    "LgwnpJoiEaAE0roXsdRVv5sF8c7aGpQM6EnXXQpuRoLXQrPF_y06PhCFyqaeKS3zdy2-SRzLZv1ItCrp6ioGGS6tKQMxkWnX_9_XsDDPxWAtxsJBOHvetLLDk8OQSEV78YiGzd5WtRVvLpWbbjjbo152pWCEtv_xVZ40f8-_TuCP8qQD0WdQjqQ2kPkAI424HCMQ8de8l31GV2E_U8nwOTE-QKfA9ShP_31t2Jg0oR846szWNWb2bkJQk6vJGglThNvEUn-GNl073pxOYBRcmlhywhjYelprxxDyoA1DcZ3c7H5xr9XXV-btAlAXA9Dh9Jphi5qfHxhi3U2SOY-3AVVebXDi_p0wjUHxgSFE8AcKgFNi6ked63xWS5HeXo3FBse9dfQoYEZOUcjGpWE568ln5osJGBNKdwm2TwpW6qf"
)


class Response(io.BytesIO):
    def __init__(self, payload: bytes, *, content_length: int | None = None) -> None:
        super().__init__(payload)
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def make_archive(executable: bytes, *, entry_name: str = "TKBCherryAgent.exe") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(entry_name, executable)
    return buffer.getvalue()


def make_manifest(archive: bytes, executable: bytes, *, version: str = "1.6.4") -> ReleaseManifest:
    return ReleaseManifest(
        version=version,
        published_at="2026-07-17T10:00:00Z",
        archive_url=f"{RELEASE_ARCHIVE_PATH}?v={version}",
        archive_sha256=hashlib.sha256(archive).hexdigest(),
        archive_size=len(archive),
        executable_sha256=hashlib.sha256(executable).hexdigest(),
        executable_size=len(executable),
        signature="unused-by-staging",
    )


class UpdaterTests(unittest.TestCase):
    def test_release_version_comparison_does_not_allow_downgrades(self) -> None:
        self.assertTrue(is_newer_version("1.6.4", "1.6.3"))
        self.assertFalse(is_newer_version("1.6.3", "1.6.3"))
        self.assertFalse(is_newer_version("1.5.9", "1.6.3"))
        with self.assertRaises(UpdateError):
            is_newer_version("1.6", "1.6.3")

    def test_embedded_release_public_key_verifies_known_signature(self) -> None:
        signature = base64.urlsafe_b64decode(
            TEST_VECTOR_SIGNATURE + "=" * (-len(TEST_VECTOR_SIGNATURE) % 4)
        )
        self.assertTrue(verify_rsa_pkcs1_sha256(b"release-test-vector-v1", signature))
        self.assertFalse(verify_rsa_pkcs1_sha256(b"tampered", signature))

    def test_manifest_rejects_unknown_fields_and_bad_signature(self) -> None:
        raw = {
            "archiveSha256": "0" * 64,
            "archiveSize": 100,
            "archiveUrl": RELEASE_ARCHIVE_PATH,
            "executableSha256": "1" * 64,
            "executableSize": 50,
            "protocol": RELEASE_PROTOCOL,
            "publishedAt": "2026-07-17T10:00:00Z",
            "signature": "AAAA",
            "signatureAlgorithm": SIGNATURE_ALGORITHM,
            "version": "1.6.4",
        }
        with self.assertRaisesRegex(UpdateError, "signature"):
            parse_release_manifest(json.dumps(raw).encode())
        raw["extra"] = True
        with self.assertRaisesRegex(UpdateError, "fields"):
            parse_release_manifest(json.dumps(raw).encode())

    def test_valid_manifest_contract_parses_after_signature_verification(self) -> None:
        raw = {
            "archiveSha256": "0" * 64,
            "archiveSize": 100,
            "archiveUrl": RELEASE_ARCHIVE_PATH,
            "executableSha256": "1" * 64,
            "executableSize": 50,
            "protocol": RELEASE_PROTOCOL,
            "publishedAt": "2026-07-17T10:00:00Z",
            "signature": "AAAA",
            "signatureAlgorithm": SIGNATURE_ALGORITHM,
            "version": "1.6.4",
        }
        with patch("agent_helper.updater.verify_rsa_pkcs1_sha256", return_value=True):
            manifest = parse_release_manifest(json.dumps(raw).encode())
        self.assertEqual(manifest.version, "1.6.4")

    def test_verified_one_entry_archive_is_staged_smoked_and_launched(self) -> None:
        executable = b"new-agent-binary"
        archive = make_archive(executable)
        manifest = make_manifest(archive, executable)
        opened_urls: list[str] = []
        smoked: list[Path] = []
        launched: list[Path] = []

        def opener(request: object, timeout: float) -> Response:
            del timeout
            opened_urls.append(getattr(request, "full_url"))
            return Response(archive, content_length=len(archive))

        with tempfile.TemporaryDirectory() as raw:
            updater = AgentUpdater(
                current_version="1.6.3",
                manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
                state_dir=Path(raw),
                opener=opener,
                smoke_runner=lambda path: smoked.append(path) or True,
                version_probe=lambda path: "1.6.4",
                spawn_process=launched.append,
            )
            staged = updater.prepare_and_launch(manifest)
            self.assertEqual(staged.read_bytes(), executable)
            self.assertEqual(smoked, [staged])
            self.assertEqual(launched, [staged])
        self.assertEqual(
            opened_urls,
            ["https://tkbcherry.com/downloads/TKBCherryAgent-Windows.zip?v=1.6.4"],
        )

    def test_tampered_download_is_removed_without_touching_existing_agent(self) -> None:
        executable = b"new-agent-binary"
        archive = make_archive(executable)
        manifest = make_manifest(archive, executable)
        tampered = archive[:-1] + bytes([archive[-1] ^ 1])
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            old_agent = root / "installed-agent.exe"
            old_agent.write_bytes(b"old-agent")
            updater = AgentUpdater(
                current_version="1.6.3",
                manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
                state_dir=root / "state",
                opener=lambda request, timeout: Response(tampered),
                smoke_runner=lambda path: True,
                version_probe=lambda path: "1.6.4",
                spawn_process=lambda path: self.fail("tampered update was launched"),
            )
            with self.assertRaisesRegex(UpdateError, "SHA-256"):
                updater.prepare_and_launch(manifest)
            self.assertEqual(old_agent.read_bytes(), b"old-agent")
            stages = list((root / "state" / "updates").glob("*"))
            self.assertEqual(stages, [])

    def test_executable_changed_by_smoke_check_is_never_launched(self) -> None:
        executable = b"new-agent-binary"
        archive = make_archive(executable)
        manifest = make_manifest(archive, executable)

        def mutate(path: Path) -> bool:
            path.write_bytes(b"changed-after-verification")
            return True

        with tempfile.TemporaryDirectory() as raw:
            updater = AgentUpdater(
                current_version="1.6.3",
                manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
                state_dir=Path(raw),
                opener=lambda request, timeout: Response(archive),
                smoke_runner=mutate,
                version_probe=lambda path: "1.6.4",
                spawn_process=lambda path: self.fail("changed executable was launched"),
            )
            with self.assertRaisesRegex(UpdateError, "changed"):
                updater.prepare_and_launch(manifest)

    def test_archive_path_traversal_is_rejected(self) -> None:
        executable = b"new-agent-binary"
        archive = make_archive(executable, entry_name="../TKBCherryAgent.exe")
        manifest = make_manifest(archive, executable)
        with tempfile.TemporaryDirectory() as raw:
            updater = AgentUpdater(
                current_version="1.6.3",
                manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
                state_dir=Path(raw),
                opener=lambda request, timeout: Response(archive),
                smoke_runner=lambda path: True,
                version_probe=lambda path: "1.6.4",
                spawn_process=lambda path: self.fail("unsafe update was launched"),
            )
            with self.assertRaisesRegex(UpdateError, "unexpected path"):
                updater.prepare_and_launch(manifest)

    def test_manifest_version_must_match_the_downloaded_executable(self) -> None:
        executable = b"new-agent-binary"
        archive = make_archive(executable)
        manifest = make_manifest(archive, executable, version="1.6.4")
        with tempfile.TemporaryDirectory() as raw:
            updater = AgentUpdater(
                current_version="1.6.3",
                manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
                state_dir=Path(raw),
                opener=lambda request, timeout: Response(archive),
                smoke_runner=lambda path: True,
                version_probe=lambda path: "1.6.3",
                spawn_process=lambda path: self.fail("wrong Agent version was launched"),
            )
            with self.assertRaisesRegex(UpdateError, "version"):
                updater.prepare_and_launch(manifest)

    def test_cross_origin_release_url_is_rejected_before_download(self) -> None:
        manifest = replace(
            make_manifest(b"archive", b"exe"),
            archive_url="https://evil.example/TKBCherryAgent-Windows.zip",
        )
        updater = AgentUpdater(
            current_version="1.6.3",
            manifest_url="https://tkbcherry.com/downloads/TKBCherryAgent-release.json",
            opener=lambda request, timeout: self.fail("unsafe URL was downloaded"),
        )
        with self.assertRaisesRegex(UpdateError, "origin"):
            updater.prepare_and_launch(manifest)


if __name__ == "__main__":
    unittest.main()
