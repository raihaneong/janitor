from pathlib import Path
import re
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

page_url = "https://mairimashitairuma-kun.com/manga/mairimashita-iruma-kun-chapter-442/"
output_dir = Path("chapter_images")
output_dir.mkdir(exist_ok=True)

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0 (authorized personal archive)"
response = session.get(page_url, timeout=30)
response.raise_for_status()

soup = BeautifulSoup(response.text, "html.parser")
page_title = soup.title.get_text(" ", strip=True) if soup.title else ""
if not page_title:
    page_title = urlparse(page_url).path.rstrip("/").split("/")[-1]
safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", page_title).strip(" .")
safe_title = re.sub(r"\s+", "_", safe_title) or "page"
image_urls = []

for img in soup.find_all("img"):
    url = img.get("src") or img.get("data-src") or img.get("data-lazy-src")
    if url:
        absolute_url = urljoin(page_url, url)
        if absolute_url not in image_urls:
            image_urls.append(absolute_url)

for index, image_url in enumerate(image_urls, start=1):
    image = session.get(image_url, timeout=30)
    image.raise_for_status()

    suffix = Path(urlparse(image_url).path).suffix or ".jpg"
    (output_dir / f"{safe_title}_{index:03}{suffix}").write_bytes(image.content)
    print(f"Saved {index}: {image_url}")
