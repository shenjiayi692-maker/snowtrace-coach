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
RUN pip install --no-cache-dir . \
    && mkdir -p /models \
    && curl -L --fail --silent --show-error \
      https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task \
      -o /models/pose_landmarker_lite.task

EXPOSE 8000
CMD ["uvicorn", "snowtrace_analysis.api:app", "--host", "0.0.0.0", "--port", "8000"]
