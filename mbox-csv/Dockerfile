FROM python:3.12-slim

WORKDIR /srv

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/       ./app/
COPY pages/     ./pages/
COPY static/    ./static/

# Runtime volumes (mounted by docker-compose or your orchestrator)
VOLUME ["/data", "/downloads"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
