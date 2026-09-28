from main import load_credentials
from google.auth.transport.requests import Request

creds = load_credentials()
print(f'Valid: {creds.valid}')
print(f'Expired: {creds.expired}')
if creds.refresh_token:
    print(f'Refresh token: {creds.refresh_token[:20]}...')
else:
    print('No refresh token')

if not creds.valid:
    if creds.expired and creds.refresh_token:
        print('Refreshing...')
        creds.refresh(Request())
        print(f'Refreshed! Valid: {creds.valid}')
    else:
        print('Cannot refresh')
else:
    print('Already valid')