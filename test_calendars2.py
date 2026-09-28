import json
import os
import sys

os.environ['CREDENTIALS_PATH'] = 'token.json'
sys.path.insert(0, '.')
from main import load_credentials

creds = load_credentials()
print(f'Token valid: {creds.valid}')
print(f'Token expiry: {creds.expiry}')

# Just test reading calendar list with the access token
import subprocess
import urllib.request

access_token = creds.token
url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
req = urllib.request.Request(url)
req.add_header('Authorization', f'Bearer {access_token}')
req.add_header('Accept', 'application/json')

try:
    response = urllib.request.urlopen(req)
    data = json.loads(response.read().decode())
    items = data.get('items', [])
    print(f'Found {len(items)} calendars:')
    for cal in items:
        print(f'  - {cal.get("summary", "?")}: {cal["id"]}')
except Exception as e:
    print(f'Error fetching calendars: {e}')