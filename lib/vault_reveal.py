# vault_reveal.py — reveal one entry from a user-configured relay vault module.
#
# Usage: python vault_reveal.py <vault_module.py> <entry_name>
# The vault module must expose reveal_entry(name) -> (ok, value).
# Stdout carries the revealed value; the caller caps it at 4 KiB.
import importlib.util
import sys


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    vault_path, entry_name = sys.argv[1], sys.argv[2]
    spec = importlib.util.spec_from_file_location('dsh_agent_relay_vault', vault_path)
    if spec is None or spec.loader is None:
        return 2
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _, value = module.reveal_entry(entry_name)
    sys.stdout.write(value)
    return 0


if __name__ == '__main__':
    sys.exit(main())
