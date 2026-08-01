# NOT VERIFIED: never built — no docker daemon was available where this was written.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8001

# The mock by default: it needs no API key, and it is what every check in this repo has run
# against. docker-compose overrides this to main:app for the real vision path.
CMD ["python", "-m", "uvicorn", "mock_server:app", "--host", "0.0.0.0", "--port", "8001"]
