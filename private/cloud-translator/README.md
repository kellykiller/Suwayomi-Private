# Bundled cloud translator 0.1.2

The main Suwayomi-Private image includes this service and an isolated Python
3.12 runtime at `/opt/translator-runtime`. `private/server/translator-update.mjs`
upgrades an existing NAS service as part of an explicitly requested Private
Update, including when the initiating updater is from an older UI image.
See [CLOUD-TRANSLATION.md](../CLOUD-TRANSLATION.md) for the user workflow.

`app` contains the image/document normalizer, OCR/translation pipeline and
renderer. `server` contains the local HTTP API, durable jobs and offline test.
The image supplies DejaVu fonts from Debian; font binaries and the previous
standalone NAS installer are not vendored. Dependency and font notices are in
`THIRD-PARTY.md` and `app/font/LICENSE.txt`.

CI runs `server/selftest.py` and all `tests/test_*.py` in the actual bundled
runtime, without network access or credentials, as user `10001:10001` with a
read-only root filesystem. The deployment helper runs the same offline selftest
before touching the existing service. Tests use synthetic pages and mocked
providers and make no billable cloud requests.
