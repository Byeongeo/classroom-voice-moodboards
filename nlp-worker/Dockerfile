FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 STANZA_RESOURCES_DIR=/models
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
RUN python -c "import stanza; stanza.download('ko', package='gsd', processors='tokenize,pos,lemma,depparse', model_dir='/models')"
COPY app.py .
RUN useradd --create-home appuser && chown -R appuser:appuser /app /models
USER appuser
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
