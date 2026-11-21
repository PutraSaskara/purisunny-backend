// backend/seed-articles.js
// Idempotent seed script — inserts 3 dummy articles for UI review.
// Safe to run multiple times (uses INSERT ... ON DUPLICATE KEY UPDATE).

require('dotenv').config();
const db = require('./config/db');

const articles = [
  {
    title: 'A Guide to Munduk\'s Hidden Waterfalls',
    slug: 'guide-to-munduk-waterfalls',
    excerpt:
      'From the thunderous cascade of Air Terjun Munduk to the serene double-drop of Melanting, discover the hidden waterfall trails that make Munduk a highland paradise.',
    content: `
<h2 id="the-call-of-the-highland-waters">The Call of the Highland Waters</h2>
<p>There is something profoundly humbling about standing at the foot of a Munduk waterfall. The mist catches the midday light and breaks it into tiny rainbows; the roar of falling water drowns out every thought except wonder. In this corner of North Bali, where the mountains meet the clouds, water has carved stories into the volcanic rock for millennia.</p>
<p>Munduk Village sits at approximately 950 metres above sea level, cradled by lush hills that channel rainfall into a network of streams and rivers. During the wet season — roughly October through March — these waterways swell into dramatic cascades that rival any in Southeast Asia. Yet even in the drier months, the waterfalls of Munduk retain a quiet, persistent grace.</p>

<h2 id="air-terjun-munduk">Air Terjun Munduk: The Grand Entrance</h2>
<p>The most accessible of Munduk's waterfalls, Air Terjun Munduk plunges roughly 25 metres into a cool, emerald pool. The walk to its base takes no more than twenty minutes from the main road, descending through a clove-and-coffee agroforest that perfumes the air with spice.</p>
<blockquote>"The first time I heard Munduk waterfall from a distance — before I even saw it — I thought it was wind moving through a bamboo grove. That deep, resonant hush is the sound the mountain makes when it breathes." — <em>Local guide, Ketut Sumiarsa</em></blockquote>
<p>Visitors are advised to arrive early, around 8:00 AM, when the morning light filters through the canopy and the crowds are yet to arrive. The pool at the base is swimmable, though the water is bracingly cool — a welcome refreshment after the humid trek down.</p>

<h2 id="melanting-twin-falls">Melanting: The Twin Falls</h2>
<p>A short drive and a more adventurous trek bring you to Melanting Waterfall, named after a local temple said to bless the surrounding farmlands. Unlike the single plunge of Air Terjun Munduk, Melanting reveals itself as a double cascade — two streams of equal power meeting in a shared basin.</p>
<p>The trail to Melanting passes through private clove plantations and requires crossing a small river via a bamboo bridge. Local farmers maintain the path, and a modest donation at the trailhead supports the village. The round trip takes roughly ninety minutes at a leisurely pace.</p>
<ul>
<li><strong>Difficulty:</strong> Moderate — uneven steps and slippery rocks</li>
<li><strong>Distance:</strong> 1.8 km round trip from the trailhead</li>
<li><strong>Best time:</strong> Morning (8:00 AM – 11:00 AM) for soft light and fewer visitors</li>
<li><strong>What to bring:</strong> Trekking sandals, a light rain jacket, and a refillable water bottle</li>
</ul>

<h2 id="golden-valley-red-rice">Golden Valley: Red Rice Terraces &amp; Cascades</h2>
<p>For those who wish to combine waterfall-chasing with one of Bali's most photogenic landscapes, the Golden Valley trail delivers both. Here, a series of small cascades feeds into traditional <em>subak</em> irrigation canals that sustain the village's famous red rice terraces.</p>
<p>The trail is gentle, weaving between rice paddies where farmers still harvest by hand using the centuries-old <em>ani-ani</em> finger knife. The rice grown here — a deep russet variety unique to the Buleleng highlands — is prized for its nutty flavour and chewy texture.</p>

<h2 id="planning-your-waterfall-trek">Planning Your Waterfall Trek</h2>
<p>Most waterfall trails in the Munduk area are within a 5-kilometre radius of the village centre. Puri Sunny Guest House provides guests with hand-drawn route maps and can arrange a local guide for approximately 200,000 IDR per person. We recommend allocating a full morning for two waterfalls, with a packed lunch enjoyed beside the water.</p>
<p>Above all, remember that these waterfalls are considered sacred by the local community. Swim respectfully, avoid leaving any waste, and greet any farmers you encounter with a friendly <em>om swastiastu</em>.</p>
    `.trim(),
    cover_image:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuC3hP83HZP9Q-nfPHa9gNUD3GA6NiPogJebGjZZfO1I32I7wFp1hNWhTIBEcb5UzDIoZU3BJYDr9AKcukVK9mZlZmTTQ21Qz0XkrnOFc80SOxwchGP-FEydW44LgH6qRS-4UEhk3jZ5WocSj7TpLRVS3hxU01lTV16P7sfIJ-ZAupQo4-aGSdInllzytsbXY2TxLlzwArFqoPJTlmZtX9DoYn9IDY4h_hM2bTAAGOcWaKHkFTo0FwNS',
    category_id: 2,
    author: 'Puri Sunny Editorial',
    read_time: 7,
    is_featured: 1,
    meta_title: 'Munduk Waterfalls Guide | Hidden Trails & Tips — Puri Sunny',
    meta_description:
      'Discover the hidden waterfalls of Munduk — Air Terjun Munduk, the Melanting twin falls, and Golden Valley. Trails, best times, and local tips from Puri Sunny.',
    og_image:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuC3hP83HZP9Q-nfPHa9gNUD3GA6NiPogJebGjZZfO1I32I7wFp1hNWhTIBEcb5UzDIoZU3BJYDr9AKcukVK9mZlZmTTQ21Qz0XkrnOFc80SOxwchGP-FEydW44LgH6qRS-4UEhk3jZ5WocSj7TpLRVS3hxU01lTV16P7sfIJ-ZAupQo4-aGSdInllzytsbXY2TxLlzwArFqoPJTlmZtX9DoYn9IDY4h_hM2bTAAGOcWaKHkFTo0FwNS',
    noindex: 0,
    published_at: '2026-09-28 08:00:00',
  },
  {
    title: 'The Story of Munduk Coffee & Clove',
    slug: 'story-of-munduk-coffee-clove',
    excerpt:
      'From colonial-era plantations to the present day, coffee and clove have shaped the landscape, economy, and daily rhythm of life in Munduk. Here is their story.',
    content: `
<h2 id="the-scent-of-the-highlands">The Scent of the Highlands</h2>
<p>Step out onto the veranda of any villa in Munduk on a dry morning, and the first thing that greets you is not the view — it is the scent. A warm, earthy fragrance mingled with a hint of spice and the faint sweetness of roasting beans. This is the aroma of Munduk's twin crops: Arabica coffee and cloves.</p>
<p>Together, coffee and clove have defined Munduk's identity for over a century. They are woven into the fabric of daily life — measured in family heirlooms, drying yards, morning harvests, and the slow, patient work of generations.</p>

<h2 id="colonial-roots-dutch-plantations">Colonial Roots: The Dutch Plantation Era</h2>
<p>The story begins in the early 1900s, when Dutch colonial administrators recognised the Buleleng highlands as ideal for cash crops. Munduk, with its cool year-round temperatures and volcanic soil, became a centre for Arabica coffee cultivation. The Dutch introduced robusta varietals and established structured plantations that reshaped the landscape.</p>
<blockquote>"My grandfather used to tell me that the Dutch surveyors arrived on horseback, wearing stiff white collars even in the mountain humidity. They marked the boundaries with stone cairns that still stand at the edge of our coffee groves." — <em>Pak Nyoman, third-generation coffee farmer</em></blockquote>
<p>Clove followed shortly after, prized both as a culinary spice and for its medicinal oil. By the 1930s, Munduk's hillsides were a patchwork of neatly terraced coffee bushes beneath a canopy of towering clove trees — a polyculture system that proved remarkably sustainable.</p>

<h2 id="from-bean-to-cup">From Bean to Cup: Munduk's Artisanal Coffee Today</h2>
<p>Today, coffee production in Munduk has largely reverted to smallholder farmers. Each family tends their own grove, typically no larger than half a hectare. The beans are hand-picked, sun-dried on woven mats, and roasted in small batches over wood fires.</p>
<p>The result is a cup with distinct character: medium body, low acidity, with notes of dark chocolate, dried plum, and a faint smoky finish. It is a coffee that demands to be drunk slowly, preferably on a shaded terrace overlooking the valley.</p>
<ul>
<li><strong>Varietal:</strong> Arabica (Typica and Bourbon)</li>
<li><strong>Altitude:</strong> 900 – 1,200 metres ASL</li>
<li><strong>Processing:</strong> Natural (dry) and honey-processed</li>
<li><strong>Harvest season:</strong> May to August</li>
<li><strong>Annual yield:</strong> Approximately 300 kg per hectare</li>
</ul>

<h2 id="clove-drying-season">Clove Drying Season: A Village in Rhythm</h2>
<p>If coffee defines Munduk's mornings, cloves define its afternoons. During the clove harvest — July through September — the village transforms. Every flat surface becomes a drying floor: woven bamboo mats spread across yards, rooftops, and even roadside verges, covered in deep rust-brown buds that release their pungent oil into the air.</p>
<p>Cloves from Munduk are prized for their high eugenol content, making them valuable for both culinary and essential oil markets. The drying process takes three to five days, during which farmers turn the buds by hand every few hours to ensure even dehydration.</p>

<h2 id="tasting-munduk-at-puri-sunny">Tasting Munduk at Puri Sunny</h2>
<p>Guests at Puri Sunny Guest House &amp; Camp can experience both crops first-hand. Our morning coffee is sourced directly from neighbouring farms, roasted on-site, and served with fresh buffalo milk. During the clove season, we offer guided walks through the drying yards, where you can observe the process and purchase organic cloves directly from the farmers.</p>
<p>It is, we believe, the most authentic taste of Munduk you will find anywhere — not because we have perfected it, but because the farmers have been perfecting it for over a hundred years.</p>
    `.trim(),
    cover_image:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuAj1lWbLVwR6BmPmyKCizruqCHoI3Ei98uwf7KKLYfbcMY68py3PKjtQ2hUtfpGrxoHE3iDABhReVoaNFbJ7lsafwm7khInrW60FjaHp6ZOAQ6-btBvPUS5CwKR_gsnzsGk5BARTnUtM7qBEw15ufKQ5vdmRsybrjx75tXrTPV5sNarMnDyOjIVc1w37kounPindwUWnkluw1Oe7_0Dk67hUsBo8nKqLx42Eh68xESb5IeU-IHReXQM',
    category_id: 1,
    author: 'Puri Sunny Editorial',
    read_time: 8,
    is_featured: 0,
    // Intentionally no SEO overrides — demonstrates fallback to
    // title / excerpt / cover_image.
    meta_title: null,
    meta_description: null,
    og_image: null,
    noindex: 0,
    published_at: '2026-09-21 08:00:00',
  },
  {
    title: 'What to Pack for a Highland Camping Trip',
    slug: 'what-to-pack-highland-camping',
    excerpt:
      'Heading to Munduk for a camping adventure? Here is our curated packing list for the North Bali highlands — from thermal layers to headlamps and everything in between.',
    content: `
<h2 id="the-highland-climate">Understanding the Highland Climate</h2>
<p>Before you pack a single item, it helps to understand where you are going. Munduk sits at 950 metres above sea level, which means temperatures here are significantly cooler than Bali's coastal resorts. Daytime averages hover around 22–25°C, but after sunset the mercury can drop to a brisk 16°C.</p>
<p>Humidity is high year-round, and brief afternoon showers are common even during the "dry" season from April to November. Packing for Munduk, then, means preparing for warmth, wetness, and the sudden chill of mountain evenings.</p>

<h2 id="clothing-layers">Clothing: The Three-Layer System</h2>
<p>We strongly recommend a three-layer approach:</p>
<ul>
<li><strong>Base layer:</strong> Lightweight, moisture-wicking fabric (merino wool or synthetic). Avoid cotton, which stays damp and chills you at night.</li>
<li><strong>Mid layer:</strong> A fleece jacket or lightweight wool sweater for warmth during evening campfires and early mornings.</li>
<li><strong>Outer layer:</strong> A waterproof and windproof shell jacket. Afternoon rain in the highlands can arrive suddenly and depart just as fast, but you will be grateful for the protection.</li>
</ul>
<p>Long trekking trousers are recommended — preferably convertible zip-offs for flexibility. A wide-brimmed sun hat and a buff or scarf for dusty trails complete the outfit.</p>

<blockquote>"The most common mistake I see is guests arriving with only beachwear. They shiver through the first night, then borrow every spare blanket we have. Pack a warm layer. Trust me." — <em>Made, Puri Sunny Camp caretaker</em></blockquote>

<h2 id="footwear">Footwear: Traction Is Everything</h2>
<p>The trails around Munduk range from well-maintained paths to slippery, root-tangled descents. Waterfall hikes, in particular, involve wet rocks and clay slopes. We recommend:</p>
<ul>
<li><strong>Trekking sandals</strong> (Chaco or Teva style) for waterfall hikes and stream crossings</li>
<li><strong>Closed-toe hiking shoes</strong> with good grip for longer trails and wet conditions</li>
<li><strong>Camp slippers or sandals</strong> for relaxing at the campsite after a day of exploring</li>
</ul>

<h2 id="camping-essentials">Camping Essentials</h2>
<p>Puri Sunny Camp is a glamping-style facility with pre-pitched canvas bell tents, comfortable mattresses, and basic lighting. Still, a few personal items will make your stay more comfortable:</p>
<ul>
<li><strong>Headlamp or flashlight</strong> — paths are unlit after dark, and stargazing walks are best with a free hand</li>
<li><strong>Reusable water bottle</strong> — filtered refill stations are available at the camp kitchen</li>
<li><strong>Earplugs</strong> — the jungle is alive at night with geckos, insects, and the occasional rooster</li>
<li><strong>Dry bag</strong> — for electronics and valuables during unexpected downpours</li>
<li><strong>Insect repellent</strong> — particularly effective formulas with DEET or picaridin</li>
</ul>

<h2 id="dont-forget">What Not to Forget</h2>
<p>Beyond the practical list, here are a few items that make the highland camping experience truly special: a notebook for journaling under lantern light, a lightweight sarong for temple visits (you will pass several on the way), and a sense of unhurried calm. Munduk rewards those who arrive without an itinerary.</p>
<p>Pack light, pack smart, and leave room in your bag for the clove coffee and woven textiles you will want to bring home.</p>
    `.trim(),
    cover_image:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuDawS2x6qmrL0YUPzEZ1qsm21qNU4lyoxSIXyThoTnTv1u-rMp-K5hJMNuaDdlNyz3MOMT91zEJCNy7BAefO0xfXdei2S_IDsy2S_b__5XgMMA0EAVAj14-zVRWzpG45ntZpiPE7KrfVeddo6EUK6JnBi4hgAcerGpSB3Dr-X-QQM4dVnnRKZ7RnE5CXxmsQRd2QJHIm9c3TqCmNXpd9l4uyQY39_H7oraj0MlZXa1NTwe792CcqUUk',
    category_id: 4,
    author: 'Puri Sunny Editorial',
    read_time: 6,
    is_featured: 0,
    meta_title: null,
    meta_description:
      'Curated highland camping packing list for Munduk, North Bali — thermal layers, footwear, camp essentials, and what not to forget.',
    og_image: null,
    noindex: 0,
    published_at: '2026-09-14 08:00:00',
  },
];

async function seed() {
  console.log('Seeding articles...');
  let count = 0;

  for (const art of articles) {
    // Determine action for logging only; the upsert itself is idempotent.
    const [existing] = await db.query('SELECT id FROM articles WHERE slug = ?', [art.slug]);
    const action = existing.length > 0 ? 'Updated' : 'Inserted';

    // Idempotent upsert keyed on the unique slug: inserts new articles and
    // refreshes existing ones (including the SEO fields) without duplicating.
    await db.query(
      `INSERT INTO articles
         (title, slug, content, excerpt, cover_image, category_id, author, read_time, is_featured,
          meta_title, meta_description, og_image, noindex, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         content = VALUES(content),
         excerpt = VALUES(excerpt),
         cover_image = VALUES(cover_image),
         category_id = VALUES(category_id),
         author = VALUES(author),
         read_time = VALUES(read_time),
         is_featured = VALUES(is_featured),
         meta_title = VALUES(meta_title),
         meta_description = VALUES(meta_description),
         og_image = VALUES(og_image),
         noindex = VALUES(noindex),
         published_at = VALUES(published_at)`,
      [
        art.title,
        art.slug,
        art.content,
        art.excerpt,
        art.cover_image,
        art.category_id,
        art.author,
        art.read_time,
        art.is_featured,
        art.meta_title ?? null,
        art.meta_description ?? null,
        art.og_image ?? null,
        art.noindex ?? 0,
        art.published_at,
      ]
    );

    console.log(`  ${action} "${art.title}" — slug: ${art.slug}`);
    count++;
  }

  console.log(`\nDone. ${count} article(s) seeded (idempotent upsert).`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
