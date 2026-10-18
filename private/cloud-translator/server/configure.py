"""Local terminal-only credential setup; no network access required."""
import getpass
import os
from pathlib import Path
import secrets
import tempfile


def store(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as f:
        temp = Path(f.name)
        f.write(value+'\n')
    temp.chmod(0o600)
    os.replace(temp, path)


def main():
    root = Path('/run/secrets')
    os.umask(0o077)
    print('Schluessel einmalig lokal speichern. Enter behaelt einen vorhandenen Wert.')
    for name, label in [('google.key', 'Google Cloud Vision'), ('openai.key', 'OpenAI')]:
        path = root / name
        value = getpass.getpass(label+' API-Schluessel (Eingabe verborgen): ').strip()
        if value:
            if len(value) > 4096 or any(c.isspace() for c in value):
                raise SystemExit('Ungueltiger Wert. Keine weiteren Aenderungen.')
            store(path, value)
        elif not path.exists():
            print(label+': noch nicht eingerichtet.')
    if not (root / 'control.token').exists():
        store(root / 'control.token', secrets.token_urlsafe(48))
    print('Gespeichert. Keine Cloud-Anfrage ausgefuehrt. Werte werden nicht ausgegeben.')


if __name__ == '__main__':
    main()
