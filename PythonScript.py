import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime

# Base URL of the website
BASE_URL = "https://ncics.org/ibtracs/index.php"
BASE_URL_ALT = "https://ncics.org/ibtracs/"

BASIN_ABBREVIATIONS = {
    "Northern Atlantic": "na",
    "Eastern Pacific" : "ep",
    "Western Pacific": "wp",
    "Northern Indian": "ni",
    "Southern Indian": "si",
    "Southern Pacific": "sp"
}

def fetch_year_page(year):
    url = f"{BASE_URL}?name=YearBasin-{year}"
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed to retrieve page for year {year}: {response.status_code}")
        return None
    return response.text

def extract_links_from_second_table(html):
    soup = BeautifulSoup(html, 'html.parser')
    tables = soup.find_all('table', {'class': 'ishade', 'summary': 'Layout table.'})
    if len(tables) < 2:
        print("Less than two tables found on the page.")
        return None
    table = tables[1]
    headers = table.find('tr').find_all('td')
    basins = [header.text.strip() for header in headers]
    basin_links = {basin: [] for basin in basins}
    rows = table.find_all('tr')[1:]
    for row in rows:
        cells = row.find_all('td')
        for index, cell in enumerate(cells):
            links = cell.find_all('a', href=True)
            for link in links:
                basin_links[basins[index]].append(f"{BASE_URL_ALT}{link['href']}")
    return basin_links

def scrape_fourth_table(link):
    response = requests.get(link)
    if response.status_code != 200:
        print(f"Failed to retrieve page: {response.status_code}")
        return None
    soup = BeautifulSoup(response.text, 'html.parser')
    tables = soup.find_all('table')
    if len(tables) < 4:
        print("Less than four tables found on the page.")
        return None
    table = tables[3]
    rows = table.find_all('tr')
    table_data = []
    for row in rows[2:]:
        cells = row.find_all(['td', 'th'])
        row_data = [cell.text.strip() for cell in cells]
        table_data.append(row_data)
    return table_data

def add_missing_dates_and_empty_cells(data):
    last_date = None
    last_row = None
    if data:
        data[0] = ['N / A' if not cell else cell for cell in data[0]]
    for row in data:
        datetime_cell = row[1]
        if " " in datetime_cell:
            last_date = datetime_cell.split()[0]
        else:
            row[1] = f"{last_date} {datetime_cell}" if last_date else datetime_cell
        for i, cell in enumerate(row):
            if cell == "N / A":
                row[i] = None
            elif not cell and last_row:
                row[i] = last_row[i]
        last_row = row
    return data

def get_typhoon_name_from_link(link):
    response = requests.get(link)
    if response.status_code == 200:
        soup = BeautifulSoup(response.content, 'html.parser')
        name_element = soup.find('h1')
        if name_element:
            return name_element.get_text(strip=True)
    return None

def save_cache(data, year, basin_name, folder_path="data"):
    basin_abbr = BASIN_ABBREVIATIONS.get(basin_name, "unknown")
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    cache_file = os.path.join(folder_path, f"{basin_abbr}_{year}_data.json")
    with open(cache_file, "w") as file:
        json.dump(data, file, indent=4)
    print(f"Data cached to file: {cache_file}")

def load_cache(year, basin_name, folder_path="data"):
    basin_abbr = BASIN_ABBREVIATIONS.get(basin_name, "unknown")
    cache_file = os.path.join(folder_path, f"{basin_abbr}_{year}_data.json")
    if os.path.exists(cache_file):
        with open(cache_file, "r") as file:
            try:
                data = json.load(file)
                print(f"Loaded data from cache: {cache_file}")
                return data
            except json.JSONDecodeError:
                print(f"Error loading cache file {cache_file}. Scraping new data.")
                return None
    return None

def save_data_as_json(year, basin_name, month=None, folder_path="data"):
    links_by_basin = extract_links_from_second_table(fetch_year_page(year))
    if not links_by_basin:
        return None
    if basin_name not in links_by_basin:
        print(f"Basin '{basin_name}' not found. Available basins: {list(links_by_basin.keys())}")
        return None
    all_typhoon_data = []
    for link in links_by_basin[basin_name]:
        typhoon_name = get_typhoon_name_from_link(link)
        if not typhoon_name:
            continue
        composite_name = typhoon_name.split()
        if len(composite_name) >= 2:
            typhoon_name = composite_name[-2]
        else:
            typhoon_name = "UNKNOWN"
        fourth_table_data = scrape_fourth_table(link)
        if not fourth_table_data:
            continue
        processed_data = add_missing_dates_and_empty_cells(fourth_table_data)
        typhoon_data = {"name": typhoon_name, "path": []}
        for row in processed_data:
            time = row[1]
            if time:
                try:
                    time_obj = datetime.strptime(time, "%Y-%m-%d %H:%M:%S")
                    if month and time_obj.month != int(month):
                        continue  # Skip rows outside the requested month
                    time = time_obj.strftime("%Y-%m-%d %H:%M")
                except ValueError:
                    pass
            lat = row[3] if row[3] != "N / A" else None
            long = row[4] if row[4] != "N / A" else None
            speed = row[5] if row[5] != "N / A" else None
            pressure = row[6] if row[6] != "N / A" else None
            if speed:
                speed = int(speed)
                if speed < 34:
                    typhoon_class = 0
                elif 34 <= speed <= 63:
                    typhoon_class = 1
                elif 64 <= speed <= 82:
                    typhoon_class = 2
                elif 83 <= speed <= 95:
                    typhoon_class = 3
                elif 96 <= speed <= 112:
                    typhoon_class = 4
                elif speed >= 113:
                    typhoon_class = 5
            else:
                typhoon_class = 0
            typhoon_data["path"].append({
                "time": time,
                "lat": float(lat) if lat else None,
                "long": float(long) if long else None,
                "speed": str(speed) if speed else "< 35",
                "pressure": str(pressure) if pressure else "> 1008",
                "class": typhoon_class
            })
        if processed_data:
            try:
                start_time = datetime.strptime(processed_data[0][1], "%Y-%m-%d %H:%M:%S")
                start_time = start_time.replace(second=0)
                typhoon_data["start_time"] = int(start_time.timestamp())
            except ValueError:
                typhoon_data["start_time"] = None
        all_typhoon_data.append(typhoon_data)
    save_cache(all_typhoon_data, year, basin_name, folder_path)
    return all_typhoon_data

def scrape_typhoon_data(year, basin_name, month=None, folder_path="data"):
    data = load_cache(year, basin_name, folder_path)
    if data:
        return data
    else:
        print(f"Cache not found. Scraping data for {basin_name} in {year}.")
        return save_data_as_json(year, basin_name, month, folder_path)

if __name__ == "__main__":
    year = input("Enter year (e.g., 2025): ").strip()
    month = input("Enter month (1-12, optional, press Enter to skip): ").strip() or None
    basin = input("Enter basin (e.g., Western Pacific): ").strip()
    data = scrape_typhoon_data(year, basin, month)
    if data:
        print(f"Fetched and cached {len(data)} typhoons.")
    else:
        print("No data available.")
