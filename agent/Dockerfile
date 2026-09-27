FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    gcc \
    g++ \
    build-essential \
    libffi-dev \
    libssl-dev \
    make \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy all project files
COPY . .

# Install the dependencies only. The agent is a set of plain modules next to
# main.py, not a package: building it (`uv pip install .`) makes setuptools
# refuse the flat layout as soon as there is more than one top-level module.
RUN uv pip install --system -r pyproject.toml

# Thin (non-deprecated) CLI: discovers the module-level `server` in main.py
CMD ["python", "-m", "livekit.agents", "start"]
