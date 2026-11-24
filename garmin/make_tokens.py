"""Only needed if Garmin asks for a two-factor code from GitHub.

Run on your own computer:  pip install garminconnect && python make_tokens.py
It logs in (asking for your MFA code), then prints a token JSON. Paste that into the
GitHub secret GARMIN_TOKENS. Never paste it into a chat or commit it.
"""
import getpass

from garminconnect import Garmin

g = Garmin(input("Garmin email: "), getpass.getpass("Garmin password: "),
           prompt_mfa=lambda: input("MFA code: "))
g.login()
print("\nCopy everything on the next line into the GARMIN_TOKENS secret:\n")
print(g.client.dumps())
