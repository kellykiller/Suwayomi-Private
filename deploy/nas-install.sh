#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" != 0 ] || [ "$#" != 1 ]; then
    printf 'Aufruf: sudo sh nas-install.sh COMMIT_SHA\n' >&2
    exit 1
fi
source_ref=$1
case "$source_ref" in *[!a-f0-9]*) printf 'Ungültige Commit-Kennung.\n' >&2; exit 1;; esac
if [ "${#source_ref}" != 40 ]; then printf 'Vollständige Commit-Kennung erforderlich.\n' >&2; exit 1; fi
base_dir='/volume3/docker/suwayomi'
docker_bin=$(command -v docker || true)
if [ -z "$docker_bin" ]; then
    for candidate in /usr/local/bin/docker /var/packages/ContainerManager/target/usr/bin/docker /var/packages/Docker/target/usr/bin/docker; do
        if [ -x "$candidate" ]; then docker_bin=$candidate; break; fi
    done
fi
if [ -z "$docker_bin" ]; then printf 'Docker-Befehl fehlt.\n' >&2; exit 1; fi
for file in "$base_dir/updater/connection.json" "$base_dir/secrets/github.token" "$base_dir/secrets/portainer.token"; do
    if [ ! -s "$file" ]; then printf 'Einrichtungsdatei fehlt: %s\n' "$file" >&2; exit 1; fi
done
chown 0:0 "$base_dir/updater" "$base_dir/secrets" "$base_dir/updater/connection.json" "$base_dir/secrets/github.token" "$base_dir/secrets/portainer.token"
chmod 700 "$base_dir/updater" "$base_dir/secrets"
chmod 600 "$base_dir/updater/connection.json" "$base_dir/secrets/github.token" "$base_dir/secrets/portainer.token"

task_tmp=$(mktemp -d /tmp/suwayomi-private.XXXXXX)
runner_image=''
completed=no
helper() {
    "$docker_bin" run --rm --network host --read-only --cap-drop ALL \
        --security-opt no-new-privileges --user 0:0 --memory 512m \
        --volume "$base_dir/updater:/update" --volume "$base_dir/secrets:/secrets:ro" \
        --volume "$task_tmp:/work" --entrypoint node "$runner_image" \
        --dns-result-order=ipv4first /work/server/installer.mjs "$@"
}
cleanup() {
    result=$?
    if [ "$completed" != yes ] && [ -n "$runner_image" ] && [ -f "$task_tmp/state.json" ]; then helper fail >/dev/null 2>&1 || true; fi
    rm -rf -- "$task_tmp"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

github_token=$(cat "$base_dir/secrets/github.token")
case "$github_token" in *[!A-Za-z0-9_]*) printf 'Ungültiger GitHub-Token.\n' >&2; exit 1;; esac
printf 'header = "Authorization: Bearer %s"\n' "$github_token" > "$task_tmp/auth.curl"
unset github_token
mkdir "$task_tmp/server"
for name in common.mjs installer.mjs worker.mjs; do
    curl -q --proxy '' --noproxy '*' -4 --silent --show-error --fail \
        --connect-timeout 15 --max-time 120 --config "$task_tmp/auth.curl" \
        --header 'Accept: application/vnd.github.raw+json' --header 'X-GitHub-Api-Version: 2022-11-28' \
        --output "$task_tmp/server/$name" \
        "https://api.github.com/repos/kellykiller/Suwayomi-Private/contents/private/server/$name?ref=$source_ref"
done
runner_image=$("$docker_bin" image inspect node:24-bookworm-slim --format '{{.Id}}' 2>/dev/null || true)
if [ -z "$runner_image" ]; then
    "$docker_bin" pull node:24-bookworm-slim
    runner_image=$("$docker_bin" image inspect node:24-bookworm-slim --format '{{.Id}}')
fi
daemon=$("$docker_bin" info --format '{{.ID}}')
helper prepare "$source_ref" "$daemon"
mkdir "$task_tmp/source"
tar -xzf "$task_tmp/source.tar.gz" -C "$task_tmp/source" --strip-components=1
image_tag="suwayomi-private:git-$source_ref"
"$docker_bin" build --build-arg "PRIVATE_COMMIT=$source_ref" -t "$image_tag" "$task_tmp/source"
"$docker_bin" image inspect "$image_tag" --format '{{.Id}}' > "$task_tmp/new-image.id"
helper deploy
completed=yes
printf '\nInstallation abgeschlossen. In Suwayomi: Einstellungen → Private Updates\n'
