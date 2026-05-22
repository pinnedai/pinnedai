#!/usr/bin/env python3
"""Assemble one text fixture from inputs. Called by parse-fp-sweep.sh.

Args:
  repo      — "org/name"
  readme    — path to README file (or empty string)
  commits   — git log output (string)
  prs_path  — path to gh-api JSON output (or empty string)
  out       — path to write the fixture JSON
"""
import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 6:
        print("usage: fixture.py REPO README_PATH COMMITS_PATH PRS_PATH OUT", file=sys.stderr)
        sys.exit(2)
    repo, readme_p, commits_p, prs_p, out_p = sys.argv[1:6]
    readme = Path(readme_p).read_text(errors="replace") if readme_p and Path(readme_p).exists() else ""
    commits = Path(commits_p).read_text(errors="replace") if commits_p and Path(commits_p).exists() else ""
    prs: list = []
    if prs_p and Path(prs_p).exists():
        try:
            prs = json.loads(Path(prs_p).read_text())
            if not isinstance(prs, list):
                prs = []
        except Exception:
            prs = []
    Path(out_p).write_text(
        json.dumps(
            {"repo": repo, "readme": readme[:50_000], "commits": commits[:200_000], "prs": prs},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
