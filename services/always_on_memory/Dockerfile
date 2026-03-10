# Dockerfile for the Always-On Memory Service
# Adapted from GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

RUN mkdir -p /app/inbox /app/data

ENV PORT=8888
ENV INBOX_PATH=/app/inbox
ENV MEMORY_DB=/app/data/memory.db
ENV CONSOLIDATE_EVERY_MINUTES=5
ENV CONSOLIDATE_MIN_EVENTS=4

EXPOSE 8888

CMD ["python", "agent.py"]
