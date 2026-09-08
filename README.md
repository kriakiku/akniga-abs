# akniga-abs

> **Дисклеймер.** Проект разработан в **образовательных** целях. Его использование может
> нарушать [правила пользования](https://akniga.org) сайтом akniga.org.
> Используйте **исключительно в ознакомительных целях**, на свой риск и
> ответственность. Авторы не поощряют обход ограничений сайта или массовый сбор данных.
>
> **Весь код в этом репозитории сгенерирован искусственным интеллектом.**

Читает метаданные аудиокниг с [akniga.org](https://akniga.org), скачивает аудио
(HLS `.ts` → один `.m4b` с главами, либо single mp3) и синхронизирует всё с
[Audiobookshelf](https://www.audiobookshelf.org): жанры, автор, исполнитель, серия и номер
тома, обложка, описание, теги. Можно подписаться на серию, автора, исполнителя или
**поиск** — новинки попадают в очередь в веб-интерфейсе.

Метаданные пишутся в Audiobookshelf как sidecar `metadata.json` и обложка рядом с книгой;
аудио hardlink’ается (или копируется) в папку библиотеки.

## Что вытягивается

| Поле | Источник |
| --- | --- |
| Жанры | `/section/...` |
| Автор | `/author/...` |
| Исполнитель | `/performer/...` |
| Серия и том | `/series/...` + `(N)` / `<span class="number">` |
| Теги | `/label/...` + тег из search-подписки |
| Обложка | `og:image` |
| Книга | slug URL + `data-bid` |

**Платные книги пропускаются** (в title нет «бесплатно», player отдаёт только preview).

## Аудио

1. `POST /ajax/player/token` + `POST /ajax/b/{bid}` с `hls=true`
2. Расшифровка `hres` / `res` (клиентский AES из публичного JS сайта)
3. Скачивание HLS-сегментов `.ts` (или одного mp3)
4. `ffmpeg` → один `.m4b` с главами (`ffmetadata`)

Cloudflare / FlareSolverr **не нужны** — akniga.org отдаёт страницы напрямую.

## Подписки

```yaml
subscriptions:
  - type: series
    value: "S.T.A.L.K.E.R. Угрюмый"
  - type: search
    value: "S.T.A.L.K.E.R."
  - type: author
    value: "Гравицкий Алексей"
  - type: narrator
    value: "Мрак79"
```

Подписка `search` обходит `/search/books/?q=...`, кладёт книги в свои серии (если есть)
и **дополнительно** ставит тег = строка поиска.

## Установка

### Docker Compose

```bash
cp config.example.yaml config/config.yaml
ABS_URL=http://audiobookshelf:13378 ABS_API_KEY=... docker compose up -d
```

Том `/library` должен указывать на **ту же** библиотеку, что и Audiobookshelf.

### Бинарник

```bash
bun install
bun run build
cp config.example.yaml config.yaml
./dist/akniga-abs serve
```

## Конфигурация

Секреты — только из окружения:

| Переменная | Назначение |
| --- | --- |
| `ABS_URL` | URL Audiobookshelf |
| `ABS_API_KEY` | API-ключ |
| `ABS_LIBRARY_DIR` | Путь к библиотеке как видит этот процесс |
| `CONFIG_FILE` | Путь к YAML |
| `DATA_DIR` / `STAGING_DIR` | SQLite и staging |
| `AUDIO_TRACK_CONCURRENCY` | Параллельные сегменты CDN |
| `HOST` / `PORT` | Веб-UI (по умолчанию `127.0.0.1:8480`) |

См. [`config.example.yaml`](config.example.yaml).

### Политика записи

`sync.writePolicy`: `fill-empty` | `overwrite-ours` (по умолчанию) | `overwrite-all`.

Каждому элементу ставится тег `akniga:<bid>`.

## Интеграция с Audiobookshelf

1. Не опускайте `absMetadata` / `metadata.json` в приоритете метаданных библиотеки.
2. Смонтируйте библиотеку с правами на запись.
3. При разных путях в ABS и в контейнере:

```yaml
audiobookshelf:
  pathMappings:
    - from: /audiobooks
      to: /library
```

## Команды CLI

```
akniga-abs serve            # веб-UI + планировщик
akniga-abs seed             # индексы авторов / исполнителей
akniga-abs subscriptions    # обновить очередь по подпискам
akniga-abs backfill [n]     # детали книг
akniga-abs sync             # sidecar → библиотека
akniga-abs once             # subs + sync
```
