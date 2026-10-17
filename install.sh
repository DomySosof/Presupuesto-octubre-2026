#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  Dashboard de Presupuesto — instalador
#  Uso: ./install.sh [--docker | --native] [--port PUERTO]
# ============================================================

PORT="${PORT:-3000}"
MODE=""

usage() {
  cat <<'EOF'
Uso: ./install.sh [opciones]

Opciones:
  --docker        Instala y arranca con Docker Compose (recomendado)
  --native        Instala con Node.js local (npm install + npm start)
  --port PUERTO   Puerto para el modo nativo (default 3000)
  -h, --help      Muestra esta ayuda

Sin opciones, se muestra un menú interactivo.
EOF
}

check_docker() {
  if command -v docker >/dev/null 2>&1 \
    && (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1); then
    return 0
  fi
  echo "ERROR: Docker (con Compose) no está disponible."
  echo "       Instalalo desde https://docs.docker.com/engine/install/ y volvé a intentar."
  return 1
}

check_node() {
  command -v node >/dev/null 2>&1 || {
    echo "ERROR: Node.js no está instalado."
    echo "       Descargalo desde https://nodejs.org (versión 20 o superior)."
    return 1
  }
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$major" -lt 20 ]; then
    echo "ERROR: se necesita Node.js 20 o superior (tenés $major)."
    return 1
  fi
}

install_docker() {
  check_docker || return 1
  echo "> Construyendo y arrancando con Docker Compose..."
  docker compose up -d --build
  echo
  echo "OK: instalación completa."
  echo "    Abrí http://localhost:43590"
  echo "    Los datos quedan guardados en ./data"
}

install_native() {
  check_node || return 1
  echo "> Instalando dependencias con npm install..."
  if ! npm install; then
    echo
    echo "ERROR: falló npm install."
    echo "       better-sqlite3 es un módulo nativo: en macOS necesitás Xcode"
    echo "       Command Line Tools y en Linux build-essential/python3."
    echo "       Si preferís no instalar eso, usá: ./install.sh --docker"
    return 1
  fi
  echo
  echo "OK: instalación completa."
  echo "    Para arrancar el servidor: npm start"
  echo "    Abrí http://localhost:$PORT"
  echo "    (cambiá el puerto con: PORT=8080 npm start)"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --docker) MODE="docker" ;;
      --native) MODE="native" ;;
      --port) PORT="$2"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Opción desconocida: $1"; usage; exit 1 ;;
    esac
    shift
  done

  echo "============================================"
  echo "  Dashboard de Presupuesto — instalador"
  echo "============================================"
  echo

  if [ -z "$MODE" ]; then
    echo "Elegí cómo instalar:"
    echo "  1) Docker (recomendado, no necesitás Node ni herramientas de compilación)"
    echo "  2) Node.js local"
    read -rp "Opción [1/2]: " opt
    case "$opt" in
      2) MODE="native" ;;
      *) MODE="docker" ;;
    esac
  fi

  if [ "$MODE" = "docker" ]; then
    install_docker
  else
    install_native
  fi
}

main "$@"
