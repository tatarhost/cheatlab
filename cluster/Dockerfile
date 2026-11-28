FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY cluster/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY cluster/ ./
EXPOSE 8000
CMD ["uvicorn", "hub_proxy:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
