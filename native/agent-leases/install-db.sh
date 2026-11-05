#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Run on J. The login role has no password and uses the existing local peer authentication.
sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
SELECT 'CREATE ROLE ubuntu LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ubuntu')
\gexec
SELECT 'CREATE DATABASE t3_agent_coordination'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 't3_agent_coordination')
\gexec
SQL
sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d t3_agent_coordination < "$source_dir/schema.sql"
