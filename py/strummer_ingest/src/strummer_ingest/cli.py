"""Command-line entry point for the ingester."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence

from .db import SCHEMA_VERSION
from .fixture import build_golden_fixture


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="strummer-ingest")
    sub = parser.add_subparsers(dest="command", required=True)

    f = sub.add_parser("build-fixture", help="(re)build the golden test fixture")
    f.add_argument("out", help="output path for the SQLite fixture")

    args = parser.parse_args(argv)

    if args.command == "build-fixture":
        count = build_golden_fixture(args.out)
        json.dump(
            {"ok": True, "out": args.out, "docs": count, "schema_version": SCHEMA_VERSION},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
