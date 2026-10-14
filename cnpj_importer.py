#!/usr/bin/env python3
"""
cnpj_importer.py

Baixa os arquivos de Dados Abertos do CNPJ (Receita Federal) via o
repositório WebDAV oficial (arquivos.receitafederal.gov.br), importa cada
um para o Postgres via COPY (streaming) e apaga o zip/CSV logo em seguida,
para nunca precisar de mais que um arquivo por vez em disco.

Uso:
    pip install requests psycopg2-binary --break-system-packages

    export PGHOST=localhost
    export PGPORT=5432
    export PGDATABASE=cnpj
    export PGUSER=postgres
    export PGPASSWORD=sua_senha_aqui

    python cnpj_importer.py                # baixa tudo (mês mais recente)
    python cnpj_importer.py --only Empresas Socios
    python cnpj_importer.py --month 2026-08 # força um mês específico
    python cnpj_importer.py --reset         # ignora o progresso salvo

O progresso é salvo em state.json na mesma pasta, então o script pode ser
interrompido e retomado a qualquer momento sem reprocessar o que já foi feito.
"""

import argparse
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import psycopg2
import requests

# ---------------------------------------------------------------------------
# Config da fonte WebDAV (Nextcloud compartilhado pela RFB)
# ---------------------------------------------------------------------------

SHARE_TOKEN = "YggdBLfdninEJX9"
WEBDAV_BASE = "https://arquivos.receitafederal.gov.br/public.php/webdav/"
AUTH = (SHARE_TOKEN, "")  # Nextcloud public share: token como usuário, senha vazia

WORKDIR = Path(__file__).parent / "cnpj_tmp"
STATE_FILE = Path(__file__).parent / "state.json"
CHUNK_SIZE = 1024 * 1024  # 1MB por chunk no download

NS = {"d": "DAV:"}

# ---------------------------------------------------------------------------
# Definição das tabelas "raw" (tudo como TEXT — tratamento vem depois)
# ---------------------------------------------------------------------------

TABLES = {
    "Empresas": {
        "table": "raw_empresas",
        "columns": [
            "cnpj_basico", "razao_social", "natureza_juridica",
            "qualificacao_responsavel", "capital_social", "porte_empresa",
            "ente_federativo_responsavel",
        ],
    },
    "Estabelecimentos": {
        "table": "raw_estabelecimentos",
        "columns": [
            "cnpj_basico", "cnpj_ordem", "cnpj_dv", "identificador_matriz_filial",
            "nome_fantasia", "situacao_cadastral", "data_situacao_cadastral",
            "motivo_situacao_cadastral", "nome_cidade_exterior", "pais",
            "data_inicio_atividade", "cnae_fiscal_principal", "cnae_fiscal_secundaria",
            "tipo_logradouro", "logradouro", "numero", "complemento", "bairro",
            "cep", "uf", "municipio", "ddd_1", "telefone_1", "ddd_2", "telefone_2",
            "ddd_fax", "fax", "correio_eletronico", "situacao_especial",
            "data_situacao_especial",
        ],
    },
    "Socios": {
        "table": "raw_socios",
        "columns": [
            "cnpj_basico", "identificador_socio", "nome_socio_razao_social",
            "cpf_cnpj_socio", "qualificacao_socio", "data_entrada_sociedade",
            "pais", "representante_legal", "nome_representante",
            "qualificacao_representante_legal", "faixa_etaria",
        ],
    },
    "Simples": {
        "table": "raw_simples",
        "columns": [
            "cnpj_basico", "opcao_simples", "data_opcao_simples",
            "data_exclusao_simples", "opcao_mei", "data_opcao_mei",
            "data_exclusao_mei",
        ],
    },
    "Cnaes": {"table": "raw_cnaes", "columns": ["codigo", "descricao"]},
    "Municipios": {"table": "raw_municipios", "columns": ["codigo", "descricao"]},
    "Naturezas": {"table": "raw_naturezas", "columns": ["codigo", "descricao"]},
    "Paises": {"table": "raw_paises", "columns": ["codigo", "descricao"]},
    "Qualificacoes": {"table": "raw_qualificacoes", "columns": ["codigo", "descricao"]},
    "Motivos": {"table": "raw_motivos", "columns": ["codigo", "descricao"]},
}


# ---------------------------------------------------------------------------
# Listagem via WebDAV (PROPFIND)
# ---------------------------------------------------------------------------

def propfind(path: str) -> ET.Element:
    """Faz um PROPFIND (Depth: 1) no path indicado e retorna a árvore XML."""
    url = WEBDAV_BASE + path
    resp = requests.request(
        "PROPFIND", url, auth=AUTH, headers={"Depth": "1"}, timeout=30
    )
    resp.raise_for_status()
    return ET.fromstring(resp.text)


def get_latest_month() -> str:
    """Lista o diretório raiz do share e retorna a pasta AAAA-MM mais recente."""
    root = propfind("")
    months = []
    for resp in root.findall("d:response", NS):
        href = resp.find("d:href", NS).text
        m = re.search(r"/(\d{4}-\d{2})/?$", href)
        if m:
            months.append(m.group(1))
    if not months:
        raise RuntimeError("Não foi possível encontrar nenhuma pasta de mês no WebDAV da RFB.")
    return sorted(set(months))[-1]


def list_files_for_month(month: str) -> list[str]:
    """Lista todos os .zip disponíveis para o mês (nomes exatos, incl. partes)."""
    root = propfind(f"{month}/")
    files = []
    for resp in root.findall("d:response", NS):
        href = resp.find("d:href", NS).text
        if href.endswith(".zip"):
            files.append(href.rsplit("/", 1)[-1])
    return sorted(files)


def group_key_for_filename(filename: str) -> str | None:
    """Mapeia 'Estabelecimentos3.zip' -> 'Estabelecimentos', 'Cnaes.zip' -> 'Cnaes'."""
    name = filename.replace(".zip", "")
    name_no_digits = re.sub(r"\d+$", "", name)
    return name_no_digits if name_no_digits in TABLES else None


# ---------------------------------------------------------------------------
# Download / extração
# ---------------------------------------------------------------------------

def download_file(month: str, filename: str, dest: Path) -> None:
    url = f"{WEBDAV_BASE}{month}/{filename}"
    with requests.get(url, auth=AUTH, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    print(f"\r  baixando {dest.name}: {pct:5.1f}%", end="", flush=True)
        print()


def extract_single_csv(zip_path: Path, extract_dir: Path) -> Path:
    """Os zips da RFB contêm um único arquivo CSV (sem extensão .csv às vezes)."""
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        if not names:
            raise RuntimeError(f"Zip vazio: {zip_path}")
        inner_name = names[0]
        zf.extract(inner_name, extract_dir)
    extracted_path = extract_dir / inner_name
    return extracted_path


# ---------------------------------------------------------------------------
# Importação para o Postgres via COPY (streaming)
# ---------------------------------------------------------------------------

def get_conn():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "cnpj"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", ""),
    )


def ensure_tables(conn):
    with conn.cursor() as cur:
        for meta in TABLES.values():
            cols_sql = ", ".join(f'"{c}" TEXT' for c in meta["columns"])
            cur.execute(f'CREATE TABLE IF NOT EXISTS "{meta["table"]}" ({cols_sql});')
    conn.commit()


class ReplaceNullBytes(io.TextIOBase):
    """Alguns CSVs da RFB têm bytes nulos esporádicos; isso quebra o COPY do
    Postgres. Esse wrapper filtra isso durante a leitura, sem carregar o
    arquivo inteiro em memória."""

    def __init__(self, fileobj):
        self._f = fileobj

    def read(self, size=-1):
        data = self._f.read(size)
        return data.replace("\x00", "")


def copy_csv_to_table(conn, csv_path: Path, table: str, columns: list[str]):
    cols_sql = ", ".join(f'"{c}"' for c in columns)
    copy_sql = (
        f'COPY "{table}" ({cols_sql}) FROM STDIN WITH '
        f"(FORMAT csv, DELIMITER ';', QUOTE '\"', ENCODING 'LATIN1')"
    )
    with conn.cursor() as cur:
        with open(csv_path, "r", encoding="latin-1", newline="") as f:
            clean = ReplaceNullBytes(f)
            cur.copy_expert(copy_sql, clean)
    conn.commit()


# ---------------------------------------------------------------------------
# Estado / progresso (permite retomar)
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"done": []}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Orquestração principal
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Importador de Dados Abertos CNPJ -> Postgres")
    parser.add_argument("--month", help="Força um mês específico, formato AAAA-MM")
    parser.add_argument("--only", nargs="*", help="Só processa esses grupos (ex: Empresas Socios)")
    parser.add_argument("--reset", action="store_true", help="Ignora o progresso salvo e reprocessa tudo")
    args = parser.parse_args()

    WORKDIR.mkdir(exist_ok=True)

    month = args.month or get_latest_month()
    print(f"Mês selecionado: {month}")

    files = list_files_for_month(month)
    if args.only:
        files = [f for f in files if group_key_for_filename(f) in args.only]

    state = {"done": []} if args.reset else load_state()
    done = set(state["done"])

    conn = get_conn()
    ensure_tables(conn)

    total = len(files)
    for i, filename in enumerate(files, 1):
        if filename in done:
            print(f"[{i}/{total}] {filename} já importado, pulando.")
            continue

        group = group_key_for_filename(filename)
        if group is None:
            print(f"[{i}/{total}] {filename} não mapeado em TABLES, pulando.")
            continue

        meta = TABLES[group]
        zip_path = WORKDIR / filename
        csv_path = None

        print(f"[{i}/{total}] Processando {filename} -> tabela {meta['table']}")

        try:
            download_file(month, filename, zip_path)
            csv_path = extract_single_csv(zip_path, WORKDIR)
            print(f"  importando para {meta['table']} ...")
            copy_csv_to_table(conn, csv_path, meta["table"], meta["columns"])
            print(f"  ok. limpando arquivos temporários...")
        finally:
            zip_path.unlink(missing_ok=True)
            if csv_path is not None and csv_path.exists():
                csv_path.unlink(missing_ok=True)

        done.add(filename)
        state["done"] = sorted(done)
        save_state(state)

    conn.close()
    print("Concluído.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrompido pelo usuário. Progresso salvo — rode de novo pra continuar de onde parou.")
        sys.exit(1)
