"""Command-line entry point for the ingester."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

from .build import build_index
from .dash import iter_fragments as dash_fragments
from .db import SCHEMA_VERSION
from .devdocs import iter_fragments as devdocs_fragments
from .embed import FakeEmbedder, FastEmbedEmbedder
from .fetch import clean_attribution, fetch_devdocs, fetch_manifest_entry
from .fixture import build_golden_fixture


def _emit(payload: dict) -> None:
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")


def _cmd_build(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    version, home, attribution = args.version, args.home, args.attribution

    if args.docset:
        # Dash docset: a self-contained bundle; the version is not discoverable.
        if not version:
            parser.error("--version is required with --docset")
        sys.stderr.write(f"reading docset {args.docset} ...\n")
        fragments = dash_fragments(
            Path(args.docset),
            library=args.library,
            version=version,
            home=home or "",
            attribution=attribution or "",
        )
        builder_version = f"dash:{Path(args.docset).stem}"
    else:
        if args.slug:
            meta = fetch_manifest_entry(args.slug)
            mtime = None
            if meta:
                version = version or meta.get("release")
                home = home or (meta.get("links") or {}).get("home")
                attribution = attribution or clean_attribution(meta.get("attribution", ""))
                mtime = meta.get("mtime")
            workdir = (
                Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="strummer-"))
            )
            sys.stderr.write(f"fetching DevDocs '{args.slug}' -> {workdir}\n")
            fetch_devdocs(args.slug, workdir, mtime=mtime)
            index_path, db_path = workdir / "index.json", workdir / "db.json"
        else:
            if not args.db:
                parser.error("--index requires --db")
            index_path, db_path = Path(args.index), Path(args.db)

        if not version:
            parser.error("--version is required (no DevDocs release was found)")

        index = json.loads(index_path.read_text())
        db = json.loads(db_path.read_text())
        fragments = devdocs_fragments(
            index,
            db,
            library=args.library,
            version=version,
            home=home or "",
            attribution=attribution or "",
        )
        builder_version = f"devdocs:{args.slug or 'local'}"

    embedder = FakeEmbedder() if args.embedder == "fake" else FastEmbedEmbedder()
    sys.stderr.write(f"embedding with {args.embedder} and building {args.out} ...\n")
    count = build_index(
        fragments,
        embedder,
        args.out,
        builder_version=builder_version,
        append=args.append,
    )
    _emit(
        {
            "ok": True,
            "out": args.out,
            "library": args.library,
            "version": version,
            "docs": count,
            "embedder": args.embedder,
            "schema_version": SCHEMA_VERSION,
        }
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="strummer-ingest")
    sub = parser.add_subparsers(dest="command", required=True)

    fixture = sub.add_parser("build-fixture", help="(re)build the golden test fixture")
    fixture.add_argument("out", help="output path for the SQLite fixture")

    build = sub.add_parser("build", help="build an index from a DevDocs source")
    source = build.add_mutually_exclusive_group(required=True)
    source.add_argument("--slug", help="DevDocs slug to fetch, e.g. 'react'")
    source.add_argument("--index", help="path to a local index.json (requires --db)")
    source.add_argument("--docset", help="path to a Dash .docset bundle")
    build.add_argument("--db", help="path to a local db.json (with --index)")
    build.add_argument("--library", required=True, help="library name, e.g. 'react'")
    build.add_argument("--version", help="doc version (defaults to the DevDocs release)")
    build.add_argument("--home", help="upstream home URL for result links")
    build.add_argument("--attribution", help="attribution text recorded per fragment")
    build.add_argument("--out", required=True, help="output path for the SQLite index")
    build.add_argument(
        "--embedder", choices=["fastembed", "fake"], default="fastembed", help="embedder to use"
    )
    build.add_argument("--workdir", help="download dir for --slug (default: a temp dir)")
    build.add_argument(
        "--append",
        action="store_true",
        help="add to an existing index (e.g. another version) instead of recreating it",
    )

    args = parser.parse_args(argv)

    if args.command == "build-fixture":
        count = build_golden_fixture(args.out)
        _emit({"ok": True, "out": args.out, "docs": count, "schema_version": SCHEMA_VERSION})
        return 0
    if args.command == "build":
        return _cmd_build(build, args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
