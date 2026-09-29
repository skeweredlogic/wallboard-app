import json
import os
import sys
import webbrowser
import threading
import time
import http.server
import urllib.parse
from google_auth_oauthlib.flow import InstalledAppFlow

# calendar: read + move events between calendars (the Tasks panel's host app)
# tasks:   read the `Wallboard` task list for the Tasks panel
# Re-authorize with --force after changing this list; the generator skips
# re-consent when the stored token already covers every scope here.
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
]
TOKEN_FILE = "token.json"
CREDENTIALS_FILE = "client_secret.json"
REDIRECT_URI = "http://localhost:8080"


class OAuthHandler(http.server.BaseHTTPRequestHandler):
    code = None
    error = None

    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)

        if 'code' in params:
            OAuthHandler.code = params['code'][0]
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body><h1>Authorization successful!</h1><p>You can close this window and return to the terminal.</p></body></html>')
        elif 'error' in params:
            OAuthHandler.error = params['error'][0]
            self.send_response(400)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(f'<html><body><h1>Authorization failed: {OAuthHandler.error}</h1></body></html>'.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def main():
    force = "--force" in sys.argv
    if os.path.exists(TOKEN_FILE) and not force:
        with open(TOKEN_FILE) as f:
            token = json.load(f)
        granted = set(token.get("scopes") or [])
        if set(SCOPES).issubset(granted):
            print(f"Token {TOKEN_FILE} already has the required scopes: {sorted(granted)}")
            print("Use --force to re-authorize anyway.")
            return
        print(f"Existing token is missing required scopes ({sorted(set(SCOPES) - granted)}); re-authorizing...")

    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
    flow.redirect_uri = REDIRECT_URI

    # If a code is provided as an argument, use it directly (skip PKCE).
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        code = args[0]
        # Exchange code directly without PKCE
        flow.fetch_token(code=code, include_client_id=True)
        creds = flow.credentials
    else:
        # Generate authorization URL
        auth_url, _ = flow.authorization_url(prompt='consent', access_type='offline')
        print(f'Please go to this URL and authorize access:')
        print(auth_url)
        print()

        # Start HTTP server to catch the callback
        server = http.server.HTTPServer(('localhost', 8080), OAuthHandler)
        thread = threading.Thread(target=server.handle_request)
        thread.daemon = True
        thread.start()

        # Open browser
        try:
            webbrowser.open(auth_url)
        except Exception as e:
            print(f'Could not open browser: {e}')

        print('Waiting for authorization...')
        thread.join(timeout=300)
        server.server_close()

        if OAuthHandler.error:
            print(f'Authorization failed: {OAuthHandler.error}')
            sys.exit(1)

        if not OAuthHandler.code:
            print('No authorization code received.')
            sys.exit(1)

        # Exchange authorization code for credentials
        flow.fetch_token(code=OAuthHandler.code)
        creds = flow.credentials

    token_data = {
        'token': creds.token,
        'refresh_token': creds.refresh_token,
        'token_uri': creds.token_uri,
        'client_id': creds.client_id,
        'client_secret': creds.client_secret,
        'scopes': SCOPES,
    }
    with open(TOKEN_FILE, 'w') as f:
        json.dump(token_data, f, indent=2)
    print(f'Token saved to {TOKEN_FILE}')


if __name__ == '__main__':
    main()