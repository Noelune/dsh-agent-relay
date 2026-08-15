import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


HERMES_ADAPTER = Path(__file__).resolve().parents[1] / "adapters" / "hermes"
sys.path.insert(0, str(HERMES_ADAPTER))

from relay_client import RelayClient  # noqa: E402


class _Response:
    def __init__(self, payload: bytes = b"{}") -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.payload


class RelayClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = RelayClient("http://127.0.0.1:19121", "beta", "secret")

    def test_legacy_ack_uses_post_endpoint_and_body(self) -> None:
        with patch.object(self.client, "_request", return_value={"accepted": True}) as request:
            result = self.client.ack("message-1", "error", "failed")

        self.assertEqual(result, {"accepted": True})
        request.assert_called_once_with(
            "POST",
            "/messages/message-1/ack",
            {"status": "error", "error": "failed"},
        )

    def test_rate_limit_response_is_retried_with_documented_backoff(self) -> None:
        rate_limited = urllib.error.HTTPError(
            "http://127.0.0.1:19121/register",
            429,
            "Too Many Requests",
            {},
            io.BytesIO(b'{"error":{"code":"rate_limited","message":"slow down"}}'),
        )
        rate_limited_again = urllib.error.HTTPError(
            "http://127.0.0.1:19121/register",
            429,
            "Too Many Requests",
            {},
            io.BytesIO(b'{"error":{"code":"rate_limited","message":"slow down"}}'),
        )

        with (
            patch(
                "relay_client.urllib.request.urlopen",
                side_effect=[rate_limited, rate_limited_again, _Response(b'{"ok":true}')],
            ) as urlopen,
            patch("relay_client.time.sleep") as sleep,
        ):
            result = self.client.register()

        self.assertEqual(result, {"ok": True})
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4])


if __name__ == "__main__":
    unittest.main()
