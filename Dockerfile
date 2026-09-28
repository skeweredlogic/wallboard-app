FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml poetry.lock* ./
RUN pip install --no-cache-dir poetry && \
    poetry config virtualenvs.create false && \
    poetry install --no-interaction --no-ansi
COPY main.py ./
EXPOSE 8000
CMD ["python", "main.py"]