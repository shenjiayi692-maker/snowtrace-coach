FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    SNOWTRACE_POSE_MODEL=/models/pose_landmarker_lite.task

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY models /models
RUN pip install --no-cache-dir .

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'curl --fail --silent "http://127.0.0.1:${PORT:-8000}/ready" >/dev/null || exit 1'
CMD ["sh", "-c", "exec uvicorn snowtrace_analysis.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
