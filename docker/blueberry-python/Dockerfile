FROM python:3.11-slim

# A small-but-useful “Code Interpreter” baseline.
# Keep this minimal to reduce image size and build time.
RUN python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir numpy pandas

WORKDIR /workspace

