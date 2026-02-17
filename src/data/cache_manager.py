"""JSON-based disk cache with TTL expiration."""
import json
import time
from pathlib import Path
from typing import Optional


class CacheManager:
    """Manages JSON cache files with configurable TTL."""

    def __init__(self, cache_dir: str = "data/cache", ttl_hours: int = 24):
        """
        Args:
            cache_dir: Directory to store cache files.
            ttl_hours: Time-to-live for cache entries in hours.
        """
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = ttl_hours * 3600

    def _path(self, key: str) -> Path:
        safe = key.replace("/", "_").replace(":", "_").replace(" ", "_")
        return self.cache_dir / f"{safe}.json"

    def get(self, key: str) -> Optional[dict]:
        """Retrieve cached data if not expired. Returns None on miss or expiry."""
        path = self._path(key)
        if not path.exists():
            return None
        try:
            with open(path, encoding="utf-8") as f:
                envelope = json.load(f)
            if time.time() - envelope["_cached_at"] > self.ttl_seconds:
                path.unlink(missing_ok=True)
                return None
            return envelope["payload"]
        except Exception:
            path.unlink(missing_ok=True)
            return None

    def set(self, key: str, data: dict) -> None:
        """Store data in cache with current timestamp."""
        path = self._path(key)
        envelope = {"_cached_at": time.time(), "payload": data}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(envelope, f, ensure_ascii=False, default=str)

    def invalidate(self, key: str) -> None:
        """Remove a specific cache entry."""
        self._path(key).unlink(missing_ok=True)

    def cleanup_expired(self) -> int:
        """Delete all expired cache entries. Returns number of deleted files."""
        count = 0
        for path in self.cache_dir.glob("*.json"):
            try:
                with open(path, encoding="utf-8") as f:
                    envelope = json.load(f)
                if time.time() - envelope["_cached_at"] > self.ttl_seconds:
                    path.unlink()
                    count += 1
            except Exception:
                path.unlink(missing_ok=True)
                count += 1
        return count
