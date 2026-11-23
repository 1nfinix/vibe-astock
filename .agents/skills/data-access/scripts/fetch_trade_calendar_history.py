"""The daily review trend needs a longer calendar without changing the session probe."""
from fetch_trade_calendar import main

if __name__ == "__main__":
    main(420, script="fetch_trade_calendar_history", include_dates=True)
