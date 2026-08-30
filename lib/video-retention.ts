type RetentionRuntime = {
  DB: D1Database;
  VIDEOS: R2Bucket;
};

type ExpiredVideoRow = {
  id: string;
  object_key: string;
  proxy_object_key: string | null;
};

export type CleanupResult = {
  selected: number;
  videosMarkedDeleted: number;
  objectKeysDeleted: number;
  failures: number;
};

export async function cleanupExpiredVideos(
  runtime: RetentionRuntime,
  nowIso = new Date().toISOString(),
  limit = 100,
): Promise<CleanupResult> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const expired = await runtime.DB.prepare(
    `SELECT id, object_key, proxy_object_key
     FROM videos
     WHERE deleted_at IS NULL AND expires_at <= ?
     ORDER BY expires_at ASC
     LIMIT ?`,
  ).bind(nowIso, boundedLimit).all<ExpiredVideoRow>();
  const rows = expired.results ?? [];
  const result: CleanupResult = {
    selected: rows.length,
    videosMarkedDeleted: 0,
    objectKeysDeleted: 0,
    failures: 0,
  };

  for (const video of rows) {
    const objectKeys = [video.object_key, video.proxy_object_key].filter((key): key is string => Boolean(key));
    try {
      if (objectKeys.length > 0) await runtime.VIDEOS.delete(objectKeys);
      const update = await runtime.DB.prepare(
        "UPDATE videos SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      ).bind(nowIso, nowIso, video.id).run();
      if ((update.meta?.changes ?? 0) > 0) {
        result.videosMarkedDeleted += 1;
        result.objectKeysDeleted += objectKeys.length;
      }
    } catch (error) {
      result.failures += 1;
      console.error("expired_video_cleanup_failed", { videoId: video.id, error });
    }
  }

  return result;
}
