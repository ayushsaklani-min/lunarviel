#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE_REPOSITORY="midnightntwrk/proof-server"
readonly IMAGE_TAG="8.1.0"
readonly EXPECTED_LAYER_DIGEST="sha256:ab2ba8217f6bfb8aeefd3777c7016bde036f31a92784fa23a0cc4ca833d68f0a"
readonly IMAGE_BINARY="/nix/store/6naj0x3l5n0b4cx722xwasyp597p6z3h-ledger-8.1.0/bin/midnight-proof-server"
readonly IMAGE_LOADER="/nix/store/jms7zxzm7w1whczwny5m3gkgdjghmi2r-glibc-2.42-51/lib/ld-linux-x86-64.so.2"
readonly IMAGE_GLIBC_LIB="/nix/store/jms7zxzm7w1whczwny5m3gkgdjghmi2r-glibc-2.42-51/lib"
readonly IMAGE_LIBGCC_LIB="/nix/store/vpxblivamvic1p5r5zny934jvg33m50r-xgcc-15.2.0-libgcc/lib"
readonly REGISTRY="https://registry-1.docker.io"
readonly ACCEPT_INDEX="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
readonly ACCEPT_MANIFEST="application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

for tool in curl find jq sha256sum tar; do
  require_tool "$tool"
done

registry_token() {
  curl -fsSL \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${IMAGE_REPOSITORY}:pull" \
    | jq -er '.token'
}

install_root() {
  printf '%s\n' "${LUNARVEIL_PROOF_ROOT:-${HOME}/.local/share/lunarveil/proof-server-8.1.0-rootfs}"
}

verify_pinned_layer() {
  local manifest="$1"
  local layer_count layer_digest
  layer_count="$(jq -er '.layers | length' <<<"$manifest")"
  layer_digest="$(jq -er '.layers[0].digest' <<<"$manifest")"

  if [[ "$layer_count" != "1" || "$layer_digest" != "$EXPECTED_LAYER_DIGEST" ]]; then
    echo "Pinned image verification failed for ${IMAGE_REPOSITORY}:${IMAGE_TAG}." >&2
    echo "Expected one layer with digest ${EXPECTED_LAYER_DIGEST}." >&2
    exit 1
  fi
}

registry_get() {
  local token="$1"
  local path="$2"
  local accept="${3:-}"
  if [[ -n "$accept" ]]; then
    curl -fsSL --config - <<EOF
header = "Authorization: Bearer ${token}"
header = "Accept: ${accept}"
url = "${REGISTRY}/v2/${IMAGE_REPOSITORY}/${path}"
EOF
  else
    curl -fsSL --config - <<EOF
header = "Authorization: Bearer ${token}"
url = "${REGISTRY}/v2/${IMAGE_REPOSITORY}/${path}"
EOF
  fi
}

resolve_manifest() {
  local token="$1"
  local index digest
  index="$(registry_get "$token" "manifests/${IMAGE_TAG}" "$ACCEPT_INDEX")"
  if jq -e '.manifests' >/dev/null <<<"$index"; then
    digest="$(jq -er '.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' <<<"$index" | head -n 1)"
  else
    digest="$IMAGE_TAG"
  fi
  registry_get "$token" "manifests/${digest}" "$ACCEPT_MANIFEST"
}

inspect_image() {
  local token manifest config_digest config
  token="$(registry_token)"
  manifest="$(resolve_manifest "$token")"
  verify_pinned_layer "$manifest"
  config_digest="$(jq -er '.config.digest' <<<"$manifest")"
  config="$(registry_get "$token" "blobs/${config_digest}")"

  echo "image=${IMAGE_REPOSITORY}:${IMAGE_TAG}"
  jq -r '"compressed-layer-bytes=\([.layers[].size] | add)"' <<<"$manifest"
  jq -r '.layers[] | [.mediaType, (.size | tostring), .digest] | @tsv' <<<"$manifest"
  jq '{architecture, os, config: {Entrypoint: .config.Entrypoint, Cmd: .config.Cmd, Env: .config.Env, WorkingDir: .config.WorkingDir, User: .config.User}}' <<<"$config"
}

extract_image() {
  local root token manifest layer_digest work_dir archive extracted_binary marker
  root="$(install_root)"
  marker="${root}/.lunarveil-proof-image"
  extracted_binary="${root}${IMAGE_BINARY}"

  if [[ -f "$marker" && -x "$extracted_binary" ]] && grep -Fxq "${IMAGE_REPOSITORY}:${IMAGE_TAG} ${EXPECTED_LAYER_DIGEST}" "$marker"; then
    echo "Proof-server rootfs already verified at ${root}"
    return
  fi
  if [[ -e "$root" ]]; then
    echo "Refusing to overwrite existing unverified path: ${root}" >&2
    exit 1
  fi

  token="$(registry_token)"
  manifest="$(resolve_manifest "$token")"
  verify_pinned_layer "$manifest"
  layer_digest="$(jq -er '.layers[0].digest' <<<"$manifest")"
  work_dir="$(mktemp -d)"

  cleanup_extract() {
    if [[ -n "${work_dir:-}" && -d "$work_dir" && "$work_dir" == "${TMPDIR:-/tmp}"/tmp.* ]]; then
      rm -rf -- "$work_dir"
    fi
  }
  trap cleanup_extract EXIT

  archive="${work_dir}/layer.tar.gz"
  echo "Downloading pinned ${IMAGE_REPOSITORY}:${IMAGE_TAG} layer..."
  registry_get "$token" "blobs/${layer_digest}" >"$archive"
  printf '%s  %s\n' "${EXPECTED_LAYER_DIGEST#sha256:}" "$archive" | sha256sum --check --status

  mkdir -p "${work_dir}/rootfs"
  # Nix store directories are intentionally read-only in the image. The local
  # extraction needs owner write permission until all duplicate directory
  # entries and their contents have been unpacked.
  tar -xzf "$archive" -C "${work_dir}/rootfs" \
    --delay-directory-restore \
    --no-same-owner \
    --no-same-permissions \
    --mode='u+rwX'
  if [[ ! -x "${work_dir}/rootfs${IMAGE_BINARY}" ]]; then
    echo "Verified layer does not contain the expected proof-server binary." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$root")"
  printf '%s\n' "${IMAGE_REPOSITORY}:${IMAGE_TAG} ${EXPECTED_LAYER_DIGEST}" >"${work_dir}/rootfs/.lunarveil-proof-image"
  mv "${work_dir}/rootfs" "$root"
  echo "Verified proof-server rootfs installed at ${root}"
}

rootfs_info() {
  local root binary
  root="$(install_root)"
  binary="${root}${IMAGE_BINARY}"
  if [[ ! -x "$binary" ]]; then
    echo "Proof-server rootfs is not installed. Run: $0 extract" >&2
    exit 1
  fi

  echo "rootfs=${root}"
  echo "binary=${binary}"
  if command -v file >/dev/null 2>&1; then
    file "$binary"
  fi
  if command -v readelf >/dev/null 2>&1; then
    readelf -l "$binary" | grep -F 'Requesting program interpreter' || true
  fi
  find "${root}/nix/store" -type f -name 'ld-linux-*.so.*' -print
}

run_image() {
  local root binary loader library_path
  root="$(install_root)"
  binary="${root}${IMAGE_BINARY}"
  loader="${root}${IMAGE_LOADER}"
  library_path="${root}${IMAGE_GLIBC_LIB}:${root}${IMAGE_LIBGCC_LIB}"
  if [[ ! -x "$binary" || ! -x "$loader" ]]; then
    echo "Proof-server rootfs is not installed. Run: $0 extract" >&2
    exit 1
  fi

  # The official binary has an absolute Nix interpreter path. Invoking its
  # verified loader directly keeps this rootless and avoids changing /nix.
  if [[ "$#" -eq 0 ]]; then
    set -- --port 6300 --job-capacity 1 --num-workers 1
  fi
  exec "$loader" --library-path "$library_path" "$binary" "$@"
}

case "${1:-inspect}" in
  inspect)
    inspect_image
    ;;
  extract)
    extract_image
    ;;
  info)
    rootfs_info
    ;;
  run)
    shift
    run_image "$@"
    ;;
  *)
    echo "Usage: $0 [inspect|extract|info|run [proof-server options]]" >&2
    exit 2
    ;;
esac
