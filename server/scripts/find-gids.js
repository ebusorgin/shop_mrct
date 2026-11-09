async function main() {
  const url = 'https://docs.google.com/spreadsheets/d/1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA/edit';
  const res = await fetch(url);
  const html = await res.text();
  
  // Find all gid numbers in URL or text
  const gidMatches = [...html.matchAll(/gid[=:](\d+)/g)].map(m => m[1]);
  const uniqueGids = [...new Set(gidMatches)];
  console.log('Found GIDs:', uniqueGids);

  // Try fetching CSV for each gid and check non-empty lines
  for (const gid of uniqueGids) {
    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/1tmtmBRcpDDRM5KaONo5wXo51RFcbm92nQ9GibFlHAzA/export?format=csv&gid=${gid}`;
      const csvRes = await fetch(csvUrl);
      const csvText = await csvRes.text();
      const lines = csvText.split(/\r?\n/);
      let nonZero = 0;
      let title = lines[0] || '';
      for (let i = 2; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length > 8 && parts.slice(8, 16).some(p => p.trim() !== '')) {
          nonZero++;
        }
      }
      console.log(`GID ${gid} | Title: "${title.slice(0, 40)}" | Non-empty rows: ${nonZero}`);
    } catch (e) {
      console.log(`GID ${gid} error:`, e.message);
    }
  }
}
main();
