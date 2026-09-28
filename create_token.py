import json
import subprocess

gcloud = r"C:\Users\rhino\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.ps1"

cmd = ['pwsh', '-ExecutionPolicy', 'Bypass', '-Command', f'& "{gcloud}" auth print-access-token']
access_token = subprocess.check_output(cmd).decode().strip()
print(f'Got access_token: {access_token[:30]}...')

cmd = ['pwsh', '-ExecutionPolicy', 'Bypass', '-Command', f'& "{gcloud}" auth print-refresh-token']
refresh_token = subprocess.check_output(cmd).decode().strip()
print(f'Got refresh_token: {refresh_token[:30]}...')

client_config = json.load(open('client_secret.json'))['installed']

token_data = {
    'token': access_token,
    'refresh_token': refresh_token,
    'token_uri': client_config['token_uri'],
    'client_id': client_config['client_id'],
    'client_secret': client_config['client_secret'],
    'scopes': ['https://www.googleapis.com/auth/calendar.readonly']
}

with open('token.json', 'w') as f:
    json.dump(token_data, f, indent=2)

print('token.json created')

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

creds = Credentials(
    token=token_data['token'],
    refresh_token=token_data['refresh_token'],
    token_uri=token_data['token_uri'],
    client_id=token_data['client_id'],
    client_secret=token_data['client_secret'],
    scopes=token_data['scopes']
)

print(f'Valid: {creds.valid}')

service = build('calendar', 'v3', credentials=creds)
cal_list = service.calendarList().list().execute()
items = cal_list.get('items', [])
print(f'Found {len(items)} calendars:')
for cal in items:
    print(f'  - {cal.get("summary", "?")}: {cal["id"]}')