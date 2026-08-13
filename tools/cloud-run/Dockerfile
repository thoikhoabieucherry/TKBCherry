FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TKB_CLOUD_RUN_QUIET=1 \
    TKB_CLOUD_RUN_MAX_WORKERS=6 \
    TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285 \
    OMP_NUM_THREADS=1 \
    OMP_THREAD_LIMIT=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    VECLIB_MAXIMUM_THREADS=1 \
    BLIS_NUM_THREADS=1

WORKDIR /app

# The deploy script computes a digest over the exact solver source copied into
# the image.  Rust pins this value in the selected Cloud profile and rejects a
# response from an image that does not advertise the expected digest.
ARG TKB_SOLVER_DIGEST=unverified
ENV TKB_CLOUD_RUN_SOLVER_DIGEST=${TKB_SOLVER_DIGEST}

COPY solver_runtime/requirements.txt /app/solver_runtime/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /app/solver_runtime/requirements.txt

COPY solver_runtime /app/solver_runtime

RUN useradd --create-home --uid 10001 tkb \
    && chown -R tkb:tkb /app
USER tkb

ENV PYTHONPATH=/app/solver_runtime/src
EXPOSE 8080

CMD ["python", "/app/solver_runtime/scripts/cloud_run_service.py"]
