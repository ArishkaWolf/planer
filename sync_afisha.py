"""Refresh the static calendar from the official NMDT schedule."""
import argparse
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

SOURCE = 'https://nmdt.ru/afisha/events/'
RELAY = 'https://api.allorigins.win/raw?'
MONTHS = 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split()
PERFORMANCE = re.compile(r'/performance/\d+/?')
CAST_HEADING = re.compile(r'<(?:b|strong)\b[^>]*>\s*роли(?:\s|&nbsp;)+исполняют\s*:?\s*</(?:b|strong)>', re.IGNORECASE)
ACTOR_NAMES = {'дмитрий нестеров', 'нестеров дмитрий', 'нестеров дмитрий викторович', 'дмитрий викторович нестеров'}


class Schedule(HTMLParser):
    def __init__(self):
        super().__init__()
        self.select = ''
        self.selected = {}
        self.row = None
        self.cell = None
        self.title = None
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'select':
            self.select = attrs.get('name', '')
        elif tag == 'option' and 'selected' in attrs and self.select in ('Month', 'Year'):
            self.selected[self.select] = int(attrs['value'])
        elif tag == 'tr':
            self.row = {'day': [], 'time': [], 'title': []}
        elif tag == 'td' and self.row is not None:
            if 'time_for_action' in attrs.get('class', '').split():
                self.cell = 'time'
                self.row['schedule'] = True
            elif attrs.get('width') == '150':
                self.cell = 'day'
        elif tag == 'a' and self.row is not None and PERFORMANCE.fullmatch(attrs.get('href', '')):
            self.row['link'] = attrs['href']
            self.title = self.row['title']

    def handle_data(self, data):
        if self.title is not None:
            self.title.append(data)
        if self.row is not None and self.cell:
            self.row[self.cell].append(data)

    def handle_endtag(self, tag):
        if tag == 'select':
            self.select = ''
        elif tag == 'a':
            self.title = None
        elif tag == 'td':
            self.cell = None
        elif tag == 'tr':
            if self.row and self.row.get('schedule'):
                self.rows.append(self.row)
            self.row = None
            self.cell = None
            self.title = None


def normalize(value):
    return ' '.join(''.join(value).split())


def event_record(day, clock, link, title):
    url = urljoin(SOURCE, link).rstrip('/')
    key = hashlib.sha256(f'{day}|{clock}|{url}'.encode()).hexdigest()[:20]
    return {'id': 'theater-' + key, 'date': day, 'time': clock, 'title': title, 'url': url}


def parse_month(html, year, month):
    page = Schedule()
    page.feed(html)
    if page.selected != {'Month': month, 'Year': year}:
        raise ValueError(f'Theater did not return the requested month {year}-{month:02}')
    if not page.rows and not re.search(r'афиша(?:\s|&nbsp;)+на', html, re.IGNORECASE):
        raise ValueError('Schedule layout changed')
    day = None
    events = {}
    for row in page.rows:
        label = normalize(row['day']).lower()
        if label:
            match = re.fullmatch(r'(\d{1,2})\s*' + MONTHS[month - 1], label)
            if not match:
                raise ValueError(f'Unexpected date label: {label}')
            day = date(year, month, int(match[1])).isoformat()
        clock = re.fullmatch(r'([01]?\d|2[0-3])[:-]([0-5]\d)', normalize(row['time']))
        title = normalize(row['title'])
        if not (day and clock and title and row.get('link')):
            raise ValueError('An event row is missing a date, time, title, or source link')
        record = event_record(day, f'{int(clock[1]):02}:{clock[2]}', row['link'], title)
        events[record['id']] = record
    return sorted(events.values(), key=lambda row: (row['date'], row['time'], row['title']))


def parse_cast(html):
    if 'постановка:' not in html.casefold() or '</html>' not in html.lower():
        raise ValueError('Expected a complete performance page')
    heading = CAST_HEADING.search(html)
    if not heading:
        return False
    end = html.lower().find('</td>', heading.end())
    if end == -1:
        raise ValueError('Cast section is incomplete')
    cell = html[heading.end():end]
    performers = re.findall(r'<nobr\b[^>]*>(.*?)</nobr>', cell, re.IGNORECASE | re.DOTALL)
    if not performers:
        raise ValueError('Cast rows could not be recognized')
    for performer in performers:
        name = normalize(unescape(re.sub(r'<[^>]*>', '', performer))).lstrip('–—- ').casefold()
        if name in ACTOR_NAMES:
            return True
    return False


def download_page(url, parse):
    failures = []
    for address, label in ((url, 'theater'), (RELAY + urlencode({'url': url}), 'public relay')):
        request = Request(address, headers={'User-Agent': 'Antrakt-calendar/1.0', 'Accept': 'text/html'})
        try:
            with urlopen(request, timeout=15) as response:
                data = response.read(2_000_001)
                if len(data) > 2_000_000:
                    raise ValueError('Schedule response is too large')
                encoding = response.headers.get_content_charset()
            for charset in dict.fromkeys(filter(None, (encoding, 'utf-8', 'windows-1251'))):
                try:
                    return parse(data.decode(charset)), label
                except (LookupError, ValueError) as error:
                    failure = error
            failures.append(f'{label}: {failure}')
        except (OSError, ValueError) as error:
            failures.append(f'{label}: {error}')
    raise ValueError('; '.join(failures))


def download_month(year, month):
    url = SOURCE + '?' + urlencode({'Month': f'{month:02}', 'Year': year})
    return download_page(url, lambda html: parse_month(html, year, month))


def annotate_cast(events, snapshots, refresh_months):
    known = {
        event['url']: event['myShow']
        for snapshot in snapshots
        for event in snapshot['events']
        if isinstance(event.get('myShow'), bool)
    }
    urls = {
        event['url'] for event in events
        if event['date'][:7] in refresh_months or event['url'] not in known
    }
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {url: pool.submit(download_page, url, parse_cast) for url in sorted(urls)}
        for url, future in pending.items():
            try:
                known[url], _ = future.result()
            except ValueError as error:
                print(f'::warning::Could not check cast for {url}: {error}')
    verified = {event['url'] for event in events} & known.keys()
    print(f'Cast checked for {len(verified)} productions')
    return [{**event, 'myShow': known.get(event['url'])} for event in events]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=Path('afisha.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    snapshots = [json.loads(path.read_text(encoding='utf-8')) for path in {args.baseline, Path('afisha.json')} if path.is_file()]
    snapshots.sort(key=lambda item: datetime.fromisoformat(item['updatedAt'].replace('Z', '+00:00')))
    previous = snapshots[-1]
    now = datetime.now(ZoneInfo('Europe/Moscow'))
    absolute_month = now.year * 12 + now.month - 1
    months = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {}
        for delta in range(-1, 3):
            year, offset = divmod(absolute_month + delta, 12)
            month = offset + 1
            pending[f'{year}-{month:02}'] = pool.submit(download_month, year, month)
        for key, future in pending.items():
            try:
                months[key], source = future.result()
                print(f'{key}: {len(months[key])} events via {source}')
            except ValueError as error:
                print(f'::warning::Could not refresh {key}: {error}')
    if not months:
        result = {**previous, 'stale': True}
    else:
        events = [event for event in previous['events'] if event['date'][:7] not in months]
        for rows in months.values():
            events.extend(rows)
        covered = set(previous['months']) - months.keys()
        covered.update(key for key, rows in months.items() if rows)
        result = {
            'updatedAt': now.astimezone(timezone.utc).isoformat(),
            'months': sorted(covered),
            'stale': len(months) < 4,
            'events': sorted(events, key=lambda row: (row['date'], row['time'], row['title'])),
        }
    result['events'] = annotate_cast(result['events'], snapshots, pending.keys())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(args.output)


if __name__ == '__main__':
    main()
