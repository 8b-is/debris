# lantern, explained to a ten-year-old

## the problem

Your family has one streaming setup and nine devices. Every device has a slightly
different version of it. The TV has four addons, your tablet has six, Dad's laptop
has a different six, and nobody knows which one is right. So when a film will not
play, everyone blames the film.

The films are not the problem. The films are fine. The *setup* is the problem,
because it is stored in nine places and fixed in none of them.

## the idea

Put the setup in one place, and let every device go and fetch it.

That place is lantern. It is not a library and it is not a shop. It is a **notice
board** with a **guest list**.

## the three jobs

**Job one: hand out permission slips.** Your family pays one company for access to a
big cupboard of films. That company gives you a key — a long secret password. Every
device needs that key to open the cupboard, which means nine copies of a password
floating around on phones and TVs.

lantern is meant to keep that key in one place and never give it to a device. A device
would ask lantern "what may I watch?", and lantern would answer with a *permission slip*
that only works for a little while. If the key ever leaks, you change it once — not
nine times.

*Honest note for a grown-up reading over your shoulder:* the permission slip part is
built. The part that holds the key is not built yet. Until it is, the key still lives
on the devices, which is exactly the problem this is meant to fix.

**Job two: hold the list of rules.** Some addons are allowed, some are not. Some
kinds of films are allowed, some are not. One rule matters more than the rest:
**only films that are already downloaded may be played.** No downloading from other
people's computers, ever. That is not a technical preference; it is the rule that
keeps the family's internet provider from ever sending a nasty letter.

lantern holds that list in one place. Change a rule once, and every device follows on
its next visit.

**Job three: hold the guest list.** Who is in the family, who has paid, and how many
devices they may bring. Five seats on the Family plan, twelve on Household. When
someone's month runs out, they quietly drop back to the free list. Nobody is locked
out mid-film; they just lose the extras.

## what lantern does *not* do

This is the part a ten-year-old should remember, because it is what makes lantern
small enough to trust.

- It does not keep any films. Not one. The films stay in the big cupboard.
- It does not pass the films along. It never touches them. It is a notice board,
  not a pipe.
- It does not show adverts. There is nothing to advertise at, because it is not
  trying to keep you looking at it.
- It does not watch you. The web page that tells you about lantern makes exactly one
  request, and that request is the one where you type your email address.

## why the money is written in whole pennies

A price is €4.90. If a computer stores that as "four point nine", it is actually
storing something like 4.8999999999999995, because computers count in halves and
tenths do not divide neatly. Usually that does not matter. On an invoice it matters
a lot: a hundred tiny errors and someone has been charged the wrong amount.

So lantern stores every price as a whole number of pennies. €4.90 is `490`. There is
no decimal point anywhere near the money. When it is time to show a human the price,
and only then, a formatter puts the point back in.

## why the door stays locked when the lock is broken

To let someone in, lantern checks a signature — a seal that proves a message really
came from the payment company and was not invented by a stranger.

A tempting mistake: "if we haven't set up the seal yet, let everyone in, so the
system is easy to try." That is the worst possible choice. A system with no seal
that lets everyone in is a free service, and it stays free until someone notices the
bill.

So lantern does the opposite: no seal, no entry. Every message is refused. If you
want to pretend to be a paying customer while testing on your own laptop, you write
the guest list file by hand. That is annoying on purpose. Annoying is cheap;
a free service is not.

## the shape of the whole thing

```
   a device asks  ──►  lantern checks the guest list  ──►  permission slip
   (TV, phone)            (is this seat paid up?)         (good for a little while)
                                  │
                                  └── the films never come through here
```

lantern is small. That is the point. A small thing that does one job can be read in
an afternoon, and a thing that can be read can be trusted.