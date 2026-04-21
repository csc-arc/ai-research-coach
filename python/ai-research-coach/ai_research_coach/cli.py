"""CLI entry point for ai-research-coach server"""

import argparse
import sys
from pathlib import Path


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        description="AI Research Coach - script execution server scoped by student_id/project_id"
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    start_parser = subparsers.add_parser(
        "start-server", help="Start the script execution server"
    )
    start_parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind the server to (default: 127.0.0.1; use 0.0.0.0 to expose externally)",
    )
    start_parser.add_argument(
        "--port", type=int, default=3339, help="Port to bind the server to (default: 3339)"
    )
    start_parser.add_argument(
        "--working-dir",
        type=Path,
        default=Path.cwd(),
        help="Server working directory root (default: current directory). "
             "Per-request work happens in <working-dir>/workspaces/<student_id>/<project_id>/",
    )
    start_parser.add_argument(
        "--passcode",
        required=True,
        help="Shared passcode required for authentication (required)",
    )
    start_parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="Additional CORS origin to allow. May be repeated. "
             "Default origins (https://arc-csc.github.io and http://localhost:5173) are always allowed.",
    )

    args = parser.parse_args()

    if args.command == "start-server":
        working_dir = Path(args.working_dir).resolve()
        working_dir.mkdir(parents=True, exist_ok=True)

        print("Starting AI Research Coach server...")
        print(f"  Working directory root: {working_dir}")
        print(f"  Per-session layout:     {working_dir}/workspaces/<student_id>/<project_id>/")
        print(f"  Host:                   {args.host}")
        print(f"  Port:                   {args.port}")
        print(f"  Extra CORS origins:     {args.allow_origin or '(none)'}")
        print()

        from .server import run_server

        run_server(
            working_dir,
            host=args.host,
            port=args.port,
            passcode=args.passcode,
            extra_origins=args.allow_origin,
        )
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
