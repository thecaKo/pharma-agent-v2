#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT_DIR}/fixtures/firebird"
DB_PATH="${FIXTURE_DIR}/PHARMACY.FDB"
INIT_SQL="${FIXTURE_DIR}/init/001-produtos.sql"

rm -f "${DB_PATH}"

docker run --rm \
  -v "${FIXTURE_DIR}:/data" \
  firebirdsql/firebird:5 \
  bash -c "
    /opt/firebird/bin/isql -user SYSDBA -password masterkey <<'SQL'
CREATE DATABASE '/data/PHARMACY.FDB' USER 'SYSDBA' PASSWORD 'masterkey' PAGE_SIZE 8192;
SQL
    /opt/firebird/bin/isql -user SYSDBA -password masterkey '/data/PHARMACY.FDB' -i '/data/init/001-produtos.sql'
  "

echo "Created ${DB_PATH}"
