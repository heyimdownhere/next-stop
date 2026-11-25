# Pinned by digest so a build always starts from the same image; Dependabot
# proposes updates (see .github/dependabot.yml).
FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CONFIG_DIR=/config \
    HOST=0.0.0.0 \
    PORT=8080 \
    PUID=99 \
    PGID=100 \
    TZ=America/Chicago

# Debian's security fixes released since the base image was built. CI passes a
# new SECURITY_UPDATES value on every run, so this step is never reused from
# its build cache (a cached copy misses fixes released since it was made).
ARG SECURITY_UPDATES=none
RUN echo "security updates: $SECURITY_UPDATES" \
 && apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-lock.txt ./
# Every package file's hash is checked against the lock: a file replaced on PyPI can't get in.
# pip itself is then removed: the app never uses it, and it carries its own copies of
# other libraries (urllib3, msgpack, setuptools) that security scans flag.
RUN pip install --no-cache-dir --require-hashes -r requirements-lock.txt \
 && pip uninstall -y pip

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY app ./app
COPY web ./web

VOLUME ["/config"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'), timeout=4).status == 200 else 1)"

# The entrypoint hands /config to PUID:PGID and drops root before the app starts.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# HOST and PORT come from the environment (see README "Configuration").
CMD ["sh", "-c", "exec uvicorn app.main:app --host \"${HOST:-0.0.0.0}\" --port \"${PORT:-8080}\" --proxy-headers --no-access-log"]
