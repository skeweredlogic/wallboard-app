import json
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

creds = Credentials.from_authorized_user_file('token.json', scopes=['https://www.googleapis.com/auth/calendar.readonly'])
service = build('calendar', 'v3', credentials=creds)
cal_list = service.calendarList().list().execute()
calendars = cal_list.get('items', [])
print('Available calendars:')
for cal in calendars:
    print(f"ID: {cal['id']}")
    print(f"  Summary: {cal.get('summary', '?')}")
    print(f"  AccessRole: {cal.get('accessRole', '?')}")
    print()
