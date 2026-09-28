from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

creds = Credentials.from_authorized_user_file('token.json', scopes=['https://www.googleapis.com/auth/calendar.readonly'])
print(f'Valid: {creds.valid}')
print(f'Expired: {creds.expired}')

service = build('calendar', 'v3', credentials=creds)
cal_list = service.calendarList().list().execute()
items = cal_list.get('items', [])
print(f'Found {len(items)} calendars:')
for cal in items:
    print(f'  - {cal.get("summary", "?")}: {cal["id"]}')